#!/usr/bin/env node
/**
 * Task 11 (linux-port): package the Meetless desktop app as AppImage + deb.
 *
 * Pipeline:
 *   1. build: npm run build:paseo && npm run build:meetless && npm run build:app
 *   2. stage <repo>/.artifacts/linux-package/app:
 *        runtime/cli.js        esbuild single-file ESM bundle of packages/runtime/dist/cli.js
 *        plugin/               packages/meetless-plugin/dist tree + plugin/linux-capture-helper.js
 *                              (esbuild single-file bundle of the linux capture-helper entry)
 *        renderer/             packages/meetless-app/dist (expo static export)
 *        scripts/electron-bootstrap.mjs, scripts/linux/icon.png
 *        package.json          main -> scripts/electron-bootstrap.mjs, electron pinned to the
 *                              version installed in the repository's node_modules
 *   3. run electron-builder (hoisted into the repository root node_modules by the
 *      npm workspaces that cover vendor/paseo/packages/*; invoked with cwd
 *      vendor/paseo/packages/desktop as the desktop workspace context) with
 *      --projectDir pointing at the staging dir and
 *      --config scripts/linux/electron-builder.meetless.yml --linux AppImage deb.
 *      Artifacts land in <repo>/release/linux.
 *
 * Bundling strategy: esbuild (available at node_modules/.bin/esbuild via the
 * paseo server dependency chain). This avoids copying a production subset of
 * the repository's node_modules into the package. Node builtins are left
 * external by --platform=node; `electron` is explicitly external. The only
 * runtime-resolved dynamic import that stays unbundled is the paseo supervisor
 * entrypoint (config.supervisorEntrypoint, loaded by path at daemon start),
 * which is not yet part of the linux package layout.
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
  await mkdir(path.join(appDir, "runtime"), { recursive: true });
  await mkdir(path.join(appDir, "plugin"), { recursive: true });
  await mkdir(path.join(appDir, "scripts", "linux"), { recursive: true });

  // Renderer: expo static web export.
  await cp(path.join(repoRoot, "packages", "meetless-app", "dist"), path.join(appDir, "renderer"), { recursive: true });

  // Plugin: full compiled tree (keeps relative-import layout) plus the single-file
  // linux capture-helper entry so the helper can be spawned without node_modules.
  await cp(path.join(repoRoot, "packages", "meetless-plugin", "dist"), path.join(appDir, "plugin"), { recursive: true });
  run(esbuildBinary, [
    path.join(repoRoot, "packages", "meetless-plugin", "dist", "src", "linux", "capture-helper-entry.js"),
    "--bundle",
    "--platform=node",
    "--format=esm",
    "--external:electron",
    `--outfile=${path.join(appDir, "plugin", "linux-capture-helper.js")}`,
  ]);

  // Runtime: single-file bundle of the desktop/daemon CLI.
  run(esbuildBinary, [
    path.join(repoRoot, "packages", "runtime", "dist", "cli.js"),
    "--bundle",
    "--platform=node",
    "--format=esm",
    "--external:electron",
    `--outfile=${path.join(appDir, "runtime", "cli.js")}`,
  ]);

  // Bootstrap + icon (electron-builder resolves linux.icon relative to the project dir).
  await cp(path.join(repoRoot, "scripts", "electron-bootstrap.mjs"), path.join(appDir, "scripts", "electron-bootstrap.mjs"));
  await cp(path.join(repoRoot, "scripts", "linux", "icon.png"), path.join(appDir, "scripts", "linux", "icon.png"));

  const rootPackage = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
  const electronVersion = JSON.parse(
    await readFile(path.join(repoRoot, "node_modules", "electron", "package.json"), "utf8"),
  ).version;
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
