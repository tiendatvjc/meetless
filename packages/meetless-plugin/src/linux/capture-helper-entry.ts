import { runLinuxCaptureHelper } from "./capture-helper-linux.js";

process.exitCode = await runLinuxCaptureHelper({ args: process.argv.slice(2) });
