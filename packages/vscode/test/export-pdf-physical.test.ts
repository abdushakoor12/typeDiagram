// [PDF-E2E-PHYSICAL] Produces a REAL .pdf file on disk using the production renderer.
import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync, statSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { warmupSyncRender } from "typediagram-core";
import { renderMarkdownToPdf } from "../src/pdf-render.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXAMPLE_MD = resolve(__dirname, "../examples/spec.md");
const OUT_DIR = resolve(__dirname, "../../../dist-test-pdfs");

describe("[PDF-E2E-PHYSICAL] writes a real .pdf file with embedded diagram vectors", () => {
  beforeAll(async () => {
    await warmupSyncRender();
    if (!existsSync(OUT_DIR)) {
      mkdirSync(OUT_DIR, { recursive: true });
    }
  });

  it("emits a real PDF for examples/spec.md with embedded vector operators", async () => {
    const md = readFileSync(EXAMPLE_MD, "utf8");
    const rendered = await renderMarkdownToPdf(md, { theme: "light", title: "spec" });
    const outPath = resolve(OUT_DIR, "spec.pdf");
    writeFileSync(outPath, rendered.pdf);

    const stats = statSync(outPath);
    const written = readFileSync(outPath);
    const latin = written.toString("latin1");
    expect(rendered.fenceCount).toBeGreaterThan(0);
    expect(stats.size).toBeGreaterThan(1024);
    expect(written.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(written.subarray(written.length - 6).toString("latin1")).toContain("%%EOF");
    expect(latin).toMatch(/ m\b| l\b| re\b/);
    expect(latin).not.toContain("/Subtype /Image");
  });

  it("produces different byte streams for dark and light themes", async () => {
    const md = readFileSync(EXAMPLE_MD, "utf8");
    const light = await renderMarkdownToPdf(md, { theme: "light", title: "spec-light" });
    const dark = await renderMarkdownToPdf(md, { theme: "dark", title: "spec-dark" });
    writeFileSync(resolve(OUT_DIR, "spec-light.pdf"), light.pdf);
    writeFileSync(resolve(OUT_DIR, "spec-dark.pdf"), dark.pdf);
    expect(Buffer.compare(Buffer.from(light.pdf), Buffer.from(dark.pdf))).not.toBe(0);
  });
});
