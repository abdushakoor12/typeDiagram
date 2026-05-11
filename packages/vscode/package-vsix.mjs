import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../..");
const MARKETPLACE_NAME = "typediagram";
const STAGED_LICENSE = "LICENSE.txt";
const STAGE_FILES = [
  "README.md",
  "dist",
  "examples",
  "icons",
  "language-configuration.json",
  "package.json",
  "syntaxes",
  "themes",
];

run("node", ["esbuild.mjs", "--production"], HERE, "esbuild failed");

const staging = mkdtempSync(join(tmpdir(), "typediagram-vsix-"));
try {
  for (const name of STAGE_FILES) {
    cpSync(resolve(HERE, name), resolve(staging, name), { recursive: true });
  }
  cpSync(resolve(REPO_ROOT, "LICENSE"), resolve(staging, STAGED_LICENSE));

  const pkgPath = resolve(staging, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  pkg.name = MARKETPLACE_NAME;
  pkg.license = pkg.license ?? "MIT";
  pkg.scripts = { ...(pkg.scripts ?? {}), "vscode:prepublish": "echo skipping prepublish" };
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

  const extraArgs = process.argv.slice(2);
  run("npx", ["@vscode/vsce", "package", "--no-dependencies", ...extraArgs], staging, "vsce package failed");

  const pkgOut = `${MARKETPLACE_NAME}-${pkg.version}.vsix`;
  cpSync(resolve(staging, pkgOut), resolve(REPO_ROOT, pkgOut));
} finally {
  rmSync(staging, { recursive: true, force: true });
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
