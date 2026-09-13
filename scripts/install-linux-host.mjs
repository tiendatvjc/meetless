import { execFile } from "node:child_process";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const supportRoot = path.join(homedir(), ".local/share/meetless");

// Dev-mode-from-repo (ledger ruling R1, final-review Issue 3): the systemd unit
// runs the REPO checkout's runtime dist directly. Staging dist under
// ~/.local/share/meetless/runtime could never start — dist/config.js imports
// bare node_modules (zod/ws/...) that only resolve up-tree from the checkout,
// and REPOSITORY_ROOT-relative paths (plugin, capture helper entry, vendored
// paseo) would resolve wrong. Real bundling ships with the Task 11 package
// (scripts/package-linux.mjs); .artifacts staging below is a dry-run preview.
const runtimeCliSource = path.join(repositoryRoot, "packages/runtime/dist/cli.js");
const runtimeDistSource = path.join(repositoryRoot, "packages/runtime/dist");
const captureHelperSource = path.join(
  repositoryRoot,
  "packages/meetless-plugin/dist/src/linux/capture-helper-entry.js",
);
const unitTemplatePath = path.join(repositoryRoot, "systemd/meetless-daemon.service");
const unitPath = path.join(homedir(), ".config/systemd/user/meetless-daemon.service");
const stagingRoot = path.join(repositoryRoot, ".artifacts/linux-host-staging");

const mode = process.argv[2] ?? "--dry-run";
if (!["--dry-run", "--install", "--uninstall"].includes(mode)) {
  console.error(`Đối số không hợp lệ: ${mode}`);
  console.error("Cách dùng: node scripts/install-linux-host.mjs [--install|--uninstall]");
  process.exit(2);
}

if (mode === "--uninstall") {
  await uninstall();
} else if (mode === "--install") {
  await install();
} else {
  await dryRun();
}

async function install() {
  await run("npm", ["run", "build:meetless"], { cwd: repositoryRoot });
  await assertSourcesPresent();
  await writeRenderedUnit();
  await run("systemctl", ["--user", "daemon-reload"]);
  await run("systemctl", ["--user", "enable", "--now", "meetless-daemon.service"]);
  console.log(`meetless daemon (dev-mode-from-repo): systemctl --user status meetless-daemon`);
  console.log(`ExecStart chạy runtime dist của repo: ${runtimeCliSource}`);
  console.log(`runtime root (dữ liệu): ${supportRoot}`);
  console.log(`web companion: npm run runtime:web (http://localhost:8082)`);
}

async function dryRun() {
  await assertSourcesPresent();
  // Preview-only staging inside the repo (gitignored .artifacts): --install
  // copies NOTHING outside the repository; the unit runs the repo checkout.
  await rm(stagingRoot, { recursive: true, force: true });
  await mkdir(path.join(stagingRoot, "runtime"), { recursive: true });
  await cp(runtimeDistSource, path.join(stagingRoot, "runtime"), { recursive: true });
  await cp(captureHelperSource, path.join(stagingRoot, "runtime/capture-helper-entry.js"));
  const unit = await renderUnit();
  console.log("[dry-run] Không ghi gì ra ngoài repo. Kế hoạch cài đặt (dev-mode-from-repo):");
  console.log("");
  console.log("1. KHÔNG sao chép runtime ra ngoài repo (bản preview nằm dưới .artifacts/linux-host-staging).");
  console.log(`   ExecStart sẽ chạy thẳng cli.js của repo: ${runtimeCliSource}`);
  console.log(`   (daemon cần node_modules của repo — dist/config.js import zod/ws — nên chạy từ checkout.)`);
  console.log("2. Capture helper: runtime tự sinh wrapper chạy được tại");
  console.log(`   ${supportRoot}/capture-helper (exec node <repo>/packages/meetless-plugin/dist/src/linux/capture-helper-entry.js)`);
  console.log("   khi daemon start (packages/runtime/src/config.ts, prepareRuntime).");
  console.log(`3. Ghi unit file (render từ systemd/meetless-daemon.service): ${unitPath}`);
  console.log("");
  console.log("--- unit file sẽ ghi ---");
  for (const line of unit.split("\n")) console.log(`    ${line}`);
  console.log("--- hết unit file ---");
  console.log("");
  console.log("4. Các lệnh systemctl sẽ chạy:");
  console.log("    systemctl --user daemon-reload");
  console.log("    systemctl --user enable --now meetless-daemon.service");
  console.log("");
  await reportPrerequisites();
  console.log("");
  console.log("Để thực sự cài: npm run host:linux:apply");
}

async function uninstall() {
  console.log(`Dừng + disable meetless-daemon (nếu đang chạy)...`);
  await run("systemctl", ["--user", "disable", "--now", "meetless-daemon.service"]).catch((error) => {
    console.log(`   (bỏ qua: ${error.message.split("\n")[0]})`);
  });
  const unitExists = await stat(unitPath).then(() => true, () => false);
  if (unitExists) {
    await rm(unitPath);
    console.log(`Đã xóa unit file: ${unitPath}`);
  } else {
    console.log(`Unit file không tồn tại: ${unitPath}`);
  }
  await run("systemctl", ["--user", "daemon-reload"]).catch(() => {});
  await run("systemctl", ["--user", "reset-failed"]).catch(() => {});
  console.log(`Giữ nguyên dữ liệu dưới ${supportRoot} và repo checkout (xóa tay nếu muốn).`);
}

async function writeRenderedUnit() {
  const unit = await renderUnit();
  await mkdir(path.dirname(unitPath), { recursive: true });
  await writeFile(unitPath, unit, { mode: 0o644 });
}

async function renderUnit() {
  const template = await readFile(unitTemplatePath, "utf8");
  // ExecStart must point at the repo checkout's cli.js and a real node binary:
  // systemd user units do not inherit the login shell PATH (e.g. nvm), so
  // "/usr/bin/env node %h/.local/share/meetless/runtime/cli.js" is replaced
  // with the node running this installer and the absolute repo path rendered
  // at install time. Paths are quoted so homedirs with spaces still parse.
  // The %h specifiers in Environment= lines are expanded by systemd itself.
  const rendered = template.replace(
    "/usr/bin/env node %h/.local/share/meetless/runtime/cli.js",
    `"${process.execPath}" "${runtimeCliSource}"`,
  );
  const execLine = rendered.split("\n").find((line) => line.startsWith("ExecStart="));
  if (!execLine || !execLine.includes(runtimeCliSource)) {
    throw new Error(
      `Không render được ExecStart từ unit template ${unitTemplatePath}; xem lại dòng ExecStart của template.`,
    );
  }
  return rendered;
}

async function assertSourcesPresent() {
  const missing = [];
  for (const candidate of [runtimeDistSource, captureHelperSource, unitTemplatePath]) {
    const exists = await stat(candidate).then(() => true, () => false);
    if (!exists) missing.push(candidate);
  }
  if (missing.length > 0) {
    console.error("Thiếu artifact build. Chạy trước:");
    console.error("    npm run build:paseo && npm run build:meetless");
    for (const candidate of missing) console.error(`  thiếu: ${candidate}`);
    process.exit(1);
  }
  const cliExists = await stat(runtimeCliSource).then(() => true, () => false);
  if (!cliExists) {
    console.error(`Thiếu ${runtimeCliSource}. Chạy: npm run build:meetless`);
    process.exit(1);
  }
}

// Informational only: reports what is on PATH and prints the apt commands.
// This script never runs apt/sudo.
async function reportPrerequisites() {
  console.log("Kiểm tra prerequisite (chỉ báo cáo, không tự cài):");
  for (const tool of ["ffmpeg", "parec", "pactl"]) {
    const present = await run("which", [tool]).then(
      () => true,
      () => false,
    );
    const aptPackage = tool === "ffmpeg" ? "ffmpeg" : "pulseaudio-utils pipewire-pulse";
    console.log(
      `  ${tool}: ${present ? "có" : `THIẾU — cài: sudo apt install ${aptPackage}`}`,
    );
  }
}
