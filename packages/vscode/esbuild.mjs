// [VSCODE-BUILD] Bundle extension (Node) + webview (browser) with esbuild.
import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const production = process.argv.includes("--production");
const HERE = dirname(fileURLToPath(import.meta.url));
const DIST_DATA_DIR = resolve(HERE, "dist/data");
const PDFKIT_DATA_DIR = resolve(HERE, "node_modules/pdfkit/js/data");

const shared = {
  bundle: true,
  sourcemap: !production,
  minify: production,
  target: "es2022",
  logLevel: "info",
};

// Extension host — runs in Node, vscode is provided at runtime
await build({
  ...shared,
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.js",
  format: "cjs",
  platform: "node",
  external: ["vscode"],
});

// Webview script — runs in browser sandboxed iframe
await build({
  ...shared,
  entryPoints: ["src/webview/main.ts"],
  outfile: "dist/webview/main.js",
  format: "iife",
  platform: "browser",
});

mkdirSync(DIST_DATA_DIR, { recursive: true });
if (existsSync(PDFKIT_DATA_DIR)) {
  cpSync(PDFKIT_DATA_DIR, DIST_DATA_DIR, { recursive: true });
}
