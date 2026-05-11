import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { downloadAndUnzipVSCode, runTests } from "@vscode/test-electron";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, "../..");
const REPO_ROOT = resolve(PKG_ROOT, "../..");
const DEFAULT_DARWIN_EXECUTABLE = "/Applications/Visual Studio Code.app/Contents/MacOS/Electron";

await main();

async function main() {
  run("npm", ["run", "-w", "typediagram-core", "build"], REPO_ROOT, "core build failed");
  run("npm", ["run", "-w", "packages/vscode", "build"], REPO_ROOT, "extension build failed");

  const vscodeExecutablePath = await resolveExecutable();
  const extensionTestsPath = resolve(__dirname, "suite/index.cjs");
  const exitCode = await runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath: PKG_ROOT,
    extensionTestsPath,
  });
  process.exit(exitCode);
}

async function resolveExecutable() {
  const override = process.env["TYPEDIAGRAM_E2E_VSCODE_EXECUTABLE"];
  if (override) {
    return override;
  }
  if (process.platform === "darwin" && process.arch === "arm64" && existsSync(DEFAULT_DARWIN_EXECUTABLE)) {
    return DEFAULT_DARWIN_EXECUTABLE;
  }
  return downloadAndUnzipVSCode("stable");
}

function run(cmd, args, cwd, errorMessage) {
  const result = spawnSync(cmd, args, {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    throw new Error(errorMessage);
  }
}
