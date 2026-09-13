#!/usr/bin/env node
/**
 * Task 11 (linux-port) + final-review Issue 4: package the Meetless desktop
 * app as AppImage + deb with a COMPLETE staging layout.
 *
 * Pipeline:
 *   1. build: npm run build:paseo && npm run build:meetless && npm run build:app
 *   2. stage <repo>/.artifacts/linux-package/app mirroring the REPOSITORY-ROOT
 *      layout the bundled runtime resolves at runtime (REPOSITORY_ROOT is
 *      derived from each bundle's own location, so app/ plays the repository):
 *        packages/runtime/dist/cli.js                esbuild single-file ESM bundle (daemon/desktop CLI)
 *        packages/runtime/dist/ui-test-envelope.js   esbuild single-file bundle
 *                                                  (scripts/electron-bootstrap.mjs imports this relative path)
 *        packages/meetless-plugin/dist/**            full compiled plugin tree — config.paths.plugin and the
 *                                                  linux capture-helper entry default are REPOSITORY_ROOT-relative
 *        vendor/paseo/packages/desktop/dist/main.js esbuild single-file bundle with a
 *                                                  createRequire banner (the bootstrap import target; electron-log
 *                                                  require()s electron at module scope)
 *        vendor/paseo/packages/server/dist/scripts/supervisor-entrypoint.js
 *        vendor/paseo/packages/server/dist/server/server/daemon-worker.js
 *                                                  esbuild single-file bundles — config.supervisorEntrypoint is
 *                                                  REPOSITORY_ROOT-relative and the supervisor spawns the worker
 *                                                  from ../server/server/daemon-worker.js relative to itself
 *        node_modules/@getpaseo/server/dist/...     the same two bundles again — the vendored desktop main's
 *                                                  packaged daemon-manager resolves
 *                                                  <resources>/app.asar.unpacked/node_modules/@getpaseo/server/...
 *        dist/daemon/node-entrypoint-runner.js       copied from the vendored desktop dist (electron-as-node relaunch)
 *        renderer/                                   packages/meetless-app/dist (expo static export)
 *        scripts/electron-bootstrap.mjs, scripts/linux/icon.png
 *        package.json                                main -> scripts/electron-bootstrap.mjs
 *   3. run electron-builder (hoisted into the repository root node_modules by
 *      the npm workspaces that cover vendor/paseo/packages/*; invoked with cwd
 *      vendor/paseo/packages/desktop as the desktop workspace context) with
 *      --projectDir pointing at the staging dir and
 *      --config scripts/linux/electron-builder.meetless.yml --linux AppImage deb.
 *      Artifacts land in <repo>/release/linux.
 *
 * Bundling strategy: esbuild (node_modules/.bin/esbuild via the paseo server
 * dependency chain), --bundle --platform=node --format=esm with `electron` as
 * the only external. Node builtins stay external via --platform=node.
 * Documented externals/residuals: optional native or peer packages
 * (node-pty, sherpa-onnx-node, bufferutil, utf-8-validate, pnpapi) are not
 * statically reachable from the bundled entries — the terminal worker and
 * speech runtime spawned later from the packaged tree would need them under
 * app/node_modules; that node_modules closure is future work and any such
 * failure is a post-launch subsystem failure, not an import-level crash.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stagingRoot = path.join(repoRoot, ".artifacts", "linux-package");
const appDir = path.join(stagingRoot, "app");
const outputDir = path.join(repoRoot, "release", "linux");
const configPath = path.join(repoRoot, "scripts", "linux", "electron-builder.meetless.yml");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", cwd: repoRoot, ...options });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with status ${result.status}`);
  }
}

async function exists(file) {
  try {
    await readFile(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * esbuild single-file ESM bundle; `electron` stays external (runtime-provided).
 * The banner defines module-scoped `require`/`__filename`/`__dirname`
 * (createRequire and fileURLToPath over the bundle's real URL) so CommonJS
 * modules inlined into the ESM output — notably electron-log's
 * `require("electron")`, the vendored `createRequire(__filename)` server
 * resolver, and the runtime-require helpers — work at runtime instead of
 * hitting esbuild's ESM shims that throw.
 */
// Identifier names are prefixed to avoid colliding with the bundle's own
// imports; __dirname is derived by substring because importing node:path here
// can collide with an inlined import of the same module.
const REQUIRE_BANNER =
  "import { createRequire as __meetlessBundleCreateRequire } from 'node:module'; " +
  "import { fileURLToPath as __meetlessBundleFileURLToPath } from 'node:url'; " +
  "const require = __meetlessBundleCreateRequire(import.meta.url); " +
  "const __filename = __meetlessBundleFileURLToPath(import.meta.url); " +
  "const __dirname = __filename.slice(0, __filename.lastIndexOf('/'));";

function bundle(entry, outfile) {
  run(path.join(repoRoot, "node_modules", ".bin", "esbuild"), [
    entry,
    "--bundle",
    "--platform=node",
    "--format=esm",
    "--external:electron",
    `--banner:js=${REQUIRE_BANNER}`,
    `--outfile=${outfile}`,
  ]);
}

async function main() {
  console.log("[package-linux] step 1/4: building paseo, meetless runtime, and renderer export");
  run("npm", ["run", "build:paseo"]);
  run("npm", ["run", "build:meetless"]);
  run("npm", ["run", "build:app"]);

  const esbuildBinary = path.join(repoRoot, "node_modules", ".bin", "esbuild");
  if (!(await exists(esbuildBinary))) {
    throw new Error("esbuild is not available at node_modules/.bin/esbuild; cannot bundle the runtime");
  }

  console.log("[package-linux] step 2/4: assembling staging dir", appDir);
  await rm(stagingRoot, { recursive: true, force: true });
  for (const directory of [
    path.join(appDir, "packages", "runtime", "dist"),
    path.join(appDir, "scripts", "linux"),
    path.join(appDir, "vendor", "paseo", "packages", "server", "dist", "scripts"),
    path.join(appDir, "vendor", "paseo", "packages", "server", "dist", "server", "server"),
    path.join(appDir, "vendor", "paseo", "packages", "desktop", "dist"),
    path.join(appDir, "node_modules", "@getpaseo", "server", "dist", "scripts"),
    path.join(appDir, "node_modules", "@getpaseo", "server", "dist", "server", "server"),
    path.join(appDir, "dist", "daemon"),
  ]) {
    await mkdir(directory, { recursive: true });
  }

  // Renderer: expo static web export.
  await cp(path.join(repoRoot, "packages", "meetless-app", "dist"), path.join(appDir, "renderer"), { recursive: true });

  // Paseo desktop resources the vendored main loads at runtime: the paseo web
  // app (served through the paseo://app/ protocol from <resources>/app-dist),
  // skills, and editor-target icons. electron-builder maps these through
  // extraResources (from: paths are staging-relative). The paseo web app
  // export is OPTIONAL at packaging time: this workspace cannot build it
  // (the vendored app workspace has no installed node_modules and its
  // expo-two-way-audio typecheck fails under the meetless hoisting), so when
  // the export is absent the packaged window loads paseo://app/ unsuccessfully
  // — a renderer-content failure recorded as a known residual, not an
  // import-level crash.
  const paseoAppDist = path.join(repoRoot, "vendor", "paseo", "packages", "app", "dist");
  if (await exists(path.join(paseoAppDist, "index.html"))) {
    await cp(paseoAppDist, path.join(appDir, "vendor", "paseo", "packages", "app", "dist"), { recursive: true });
  } else {
    console.warn(
      `[package-linux] WARNING: paseo web app export missing at ${paseoAppDist}; ` +
        "the packaged desktop window will fail to load paseo://app/ content (run the paseo app build:web to include it).",
    );
  }
  await cp(path.join(repoRoot, "vendor", "paseo", "skills"), path.join(appDir, "vendor", "paseo", "skills"), { recursive: true });
  await cp(
    path.join(repoRoot, "vendor", "paseo", "packages", "desktop", "assets", "editor-targets"),
    path.join(appDir, "vendor", "paseo", "packages", "desktop", "assets", "editor-targets"),
    { recursive: true },
  );

  // Plugin: full compiled tree at the REPOSITORY_ROOT-relative path so
  // config.paths.plugin and the linux capture-helper entry default resolve.
  await cp(
    path.join(repoRoot, "packages", "meetless-plugin", "dist"),
    path.join(appDir, "packages", "meetless-plugin", "dist"),
    { recursive: true },
  );

  // Runtime bundles: the daemon/desktop CLI plus the ui-test envelope the
  // Electron bootstrap imports from ../packages/runtime/dist/.
  const runtimeDist = path.join(repoRoot, "packages", "runtime", "dist");
  bundle(path.join(runtimeDist, "cli.js"), path.join(appDir, "packages", "runtime", "dist", "cli.js"));
  bundle(
    path.join(runtimeDist, "ui-test-envelope.js"),
    path.join(appDir, "packages", "runtime", "dist", "ui-test-envelope.js"),
  );

  // Vendored desktop tree: the full compiled dist (preload scripts and the
  // feature/window modules Electron loads as separate FILES by path), with
  // main.js replaced by the single-file bundle carrying the require banner.
  await cp(
    path.join(repoRoot, "vendor", "paseo", "packages", "desktop", "dist"),
    path.join(appDir, "vendor", "paseo", "packages", "desktop", "dist"),
    { recursive: true },
  );
  bundle(
    path.join(repoRoot, "vendor", "paseo", "packages", "desktop", "dist", "main.js"),
    path.join(appDir, "vendor", "paseo", "packages", "desktop", "dist", "main.js"),
  );

  // Supervisor + daemon worker single-file bundles, staged at BOTH the
  // REPOSITORY_ROOT-relative layout (config.supervisorEntrypoint) and the
  // node_modules/@getpaseo layout the vendored desktop main resolves when
  // app.isPackaged. The supervisor spawns the worker from
  // ../server/server/daemon-worker.js relative to itself, which is why the
  // worker bundle must sit exactly there.
  const serverDist = path.join(repoRoot, "vendor", "paseo", "packages", "server", "dist");
  const supervisorEntry = path.join(serverDist, "scripts", "supervisor-entrypoint.js");
  const daemonWorker = path.join(serverDist, "server", "server", "daemon-worker.js");
  for (const missing of [supervisorEntry, daemonWorker]) {
    if (!(await exists(missing))) {
      throw new Error(`vendored paseo server build is missing ${missing}; run npm run build:paseo first`);
    }
  }
  const stagedSupervisor = path.join(appDir, "vendor", "paseo", "packages", "server", "dist", "scripts", "supervisor-entrypoint.js");
  const stagedWorker = path.join(appDir, "vendor", "paseo", "packages", "server", "dist", "server", "server", "daemon-worker.js");
  const mirroredSupervisor = path.join(appDir, "node_modules", "@getpaseo", "server", "dist", "scripts", "supervisor-entrypoint.js");
  const mirroredWorker = path.join(appDir, "node_modules", "@getpaseo", "server", "dist", "server", "server", "daemon-worker.js");
  bundle(supervisorEntry, stagedSupervisor);
  bundle(daemonWorker, stagedWorker);
  await cp(stagedSupervisor, mirroredSupervisor);
  await cp(stagedWorker, mirroredWorker);

  // Runtime-resolved npm deps: the vendored executable-resolution module does
  // `createRequire(import.meta.url)` + top-level `require("which")`, which the
  // bundler cannot inline. Stage the (dependency-light, pure-JS) closure under
  // app/node_modules so Electron's asar-aware require resolves it.
  await cp(path.join(repoRoot, "node_modules", "which"), path.join(appDir, "node_modules", "which"), { recursive: true });
  await cp(path.join(repoRoot, "node_modules", "isexe"), path.join(appDir, "node_modules", "isexe"), { recursive: true });

  // Electron-as-node relaunch runner the packaged supervisor/desktop expect at
  // <app-root>/dist/daemon/node-entrypoint-runner.js.
  await cp(
    path.join(repoRoot, "vendor", "paseo", "packages", "desktop", "dist", "daemon", "node-entrypoint-runner.js"),
    path.join(appDir, "dist", "daemon", "node-entrypoint-runner.js"),
  );

  // Bootstrap + icon (electron-builder resolves linux.icon relative to the project dir).
  await cp(path.join(repoRoot, "scripts", "electron-bootstrap.mjs"), path.join(appDir, "scripts", "electron-bootstrap.mjs"));
  await cp(path.join(repoRoot, "scripts", "linux", "icon.png"), path.join(appDir, "scripts", "linux", "icon.png"));

  const rootPackage = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
  const electronVersion = JSON.parse(
    await readFile(path.join(repoRoot, "node_modules", "electron", "package.json"), "utf8"),
  ).version;
  // electron-builder computes the shipped node_modules tree from these
  // dependencies (files patterns do not govern node_modules); `which` is the
  // runtime require() closure of the vendored executable-resolution module.
  const whichVersion = JSON.parse(await readFile(path.join(repoRoot, "node_modules", "which", "package.json"), "utf8")).version;
  const isexeVersion = JSON.parse(await readFile(path.join(repoRoot, "node_modules", "isexe", "package.json"), "utf8")).version;
  await writeFile(
    path.join(appDir, "package.json"),
    `${JSON.stringify(
      {
        name: "meetless",
        productName: "Meetless",
        version: rootPackage.version,
        description: "Meetless meeting recorder desktop app",
        author: "tiendatvjc <tiendatvjc@users.noreply.github.com>",
        homepage: "https://github.com/tiendatvjc/meetless",
        type: "module",
        main: "scripts/electron-bootstrap.mjs",
        dependencies: { which: whichVersion, isexe: isexeVersion },
        devDependencies: { electron: electronVersion },
      },
      null,
      2,
    )}\n`,
  );

  console.log("[package-linux] step 3/4: running electron-builder (AppImage + deb)");
  run(path.join(repoRoot, "node_modules", ".bin", "electron-builder"), [
    "--projectDir",
    appDir,
    "--config",
    configPath,
    "--linux",
    "AppImage",
    "deb",
  ], { cwd: path.join(repoRoot, "vendor", "paseo", "packages", "desktop") });

  console.log("[package-linux] step 4/4: artifact manifest");
  const artifacts = (await readdir(outputDir)).filter((name) => name.endsWith(".AppImage") || name.endsWith(".deb"));
  if (artifacts.length === 0) {
    throw new Error(`no AppImage/deb artifacts were produced in ${outputDir}`);
  }
  for (const name of artifacts) {
    const file = path.join(outputDir, name);
    const bytes = await readFile(file);
    console.log(
      `${createHash("sha256").update(bytes).digest("hex")}  ${name}  (${(bytes.length / 1024 / 1024).toFixed(1)} MiB)`,
    );
  }
  console.log("[package-linux] done:", outputDir);
}

await main();
