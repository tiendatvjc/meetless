import { execFile } from "node:child_process";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const supportRoot = path.join(homedir(), ".local/share/meetless");
const runtimeRoot = path.join(supportRoot, "runtime");

// Verified dist layouts: the runtime package emits flat dist (cli.js plus the
// sibling modules cli.js imports), while the plugin package nests under dist/src.
const runtimeDistSource = path.join(repositoryRoot, "packages/runtime/dist");
const captureHelperSource = path.join(
  repositoryRoot,
  "packages/meetless-plugin/dist/src/linux/capture-helper-entry.js",
);
const unitTemplatePath = path.join(repositoryRoot, "systemd/meetless-daemon.service");
const unitPath = path.join(homedir(), ".config/systemd/user/meetless-daemon.service");

const stagedCliPath = path.join(runtimeRoot, "cli.js");
const stagedCaptureHelperPath = path.join(runtimeRoot, "capture-helper-entry.js");
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
  await mkdir(runtimeRoot, { recursive: true });
  await cp(runtimeDistSource, runtimeRoot, { recursive: true });
  await cp(captureHelperSource, stagedCaptureHelperPath);
  await writeRenderedUnit();
  await run("systemctl", ["--user", "daemon-reload"]);
  await run("systemctl", ["--user", "enable", "--now", "meetless-daemon.service"]);
  console.log(`meetless daemon: systemctl --user status meetless-daemon`);
  console.log(`web companion: npm run runtime:web (http://localhost:8082)`);
}

async function dryRun() {
  await assertSourcesPresent();
  // Stage inside the repo only (gitignored .artifacts); nothing outside the
  // repository is written in dry-run mode.
  await rm(stagingRoot, { recursive: true, force: true });
  await mkdir(path.join(stagingRoot, "runtime"), { recursive: true });
  await cp(runtimeDistSource, path.join(stagingRoot, "runtime"), { recursive: true });
  await cp(captureHelperSource, path.join(stagingRoot, "runtime/capture-helper-entry.js"));
  const unit = await renderUnit();
  console.log("[dry-run] Không ghi gì ra ngoài repo. Kế hoạch cài đặt:");
  console.log("");
  console.log("1. Sao chép runtime (cả cây packages/runtime/dist, cli.js cần các module kề nó):");
  console.log(`   ${runtimeDistSource}${path.sep}  ->  ${runtimeRoot}${path.sep}`);
  console.log(`   (daemon: ${stagedCliPath})`);
  console.log("2. Sao chép capture helper (chỉ stage + ghi nhận đường dẫn; wiring config là task sau):");
  console.log(`   ${captureHelperSource}  ->  ${stagedCaptureHelperPath}`);
  console.log(`   (đường dẫn tuyệt đối dự kiến cho captureHelperPath: ${stagedCaptureHelperPath})`);
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
  console.log(`Giữ nguyên dữ liệu + runtime đã stage dưới ${supportRoot} (xóa tay nếu muốn).`);
}

async function writeRenderedUnit() {
  const unit = await renderUnit();
  await mkdir(path.dirname(unitPath), { recursive: true });
  await writeFile(unitPath, unit, { mode: 0o644 });
}

async function renderUnit() {
  const template = await readFile(unitTemplatePath, "utf8");
  // ExecStart must point at the real staged cli.js and a real node binary:
  // systemd user units do not inherit the login shell PATH (e.g. nvm), so
  // "/usr/bin/env node" is replaced with the node running this installer.
  // The %h specifiers in Environment= lines are expanded by systemd itself.
  return template.replace(
    "/usr/bin/env node %h/.local/share/meetless/runtime/cli.js",
    `${process.execPath} ${stagedCliPath}`,
  );
}

async function assertSourcesPresent() {
  const missing = [];
  for (const candidate of [runtimeDistSource, captureHelperSource, unitTemplatePath]) {
    const exists = await stat(candidate).then(() => true, () => false);
    if (!exists) missing.push(candidate);
  }
  if (missing.length > 0) {
    console.error("Thiếu artifact build. Chạy trước:");
    console.error("    npm run build:paseo:types && npm run build:meetless");
    for (const candidate of missing) console.error(`  thiếu: ${candidate}`);
    process.exit(1);
  }
  const cliExists = await stat(path.join(runtimeDistSource, "cli.js")).then(() => true, () => false);
  if (!cliExists) {
    console.error(`Thiếu ${path.join(runtimeDistSource, "cli.js")}. Chạy: npm run build:meetless`);
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
    const aptPackage = tool === "ffmpeg" ? "ffmpeg" : "pipewire-audio-utils";
    console.log(
      `  ${tool}: ${present ? "có" : `THIẾU — cài: sudo apt install ${aptPackage}`}`,
    );
  }
}
