// [PDF] Unit tests for the PDF export pipeline.
// Stage IDs map to the spec: [PDF-READ] [PDF-COMPOSE] [PDF-RENDER] [PDF-SAVE].
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as mock from "./vscode-mock.js";
import { warmupSyncRender } from "typediagram-core";
import type * as vscodeTypes from "vscode";

vi.mock("vscode", () => mock);
import {
  buildShell,
  composeHtml,
  exportPdf,
  extractSvgs,
  readMarkdown,
  reinjectSvgs,
  siblingPdfPath,
  splitSentinelText,
  writeNextToSource,
  type ExportPdfDeps,
} from "../src/export-pdf.js";
import { pdfRenderTestUtils, renderMarkdownToPdf } from "../src/pdf-render.js";

const PDF_MAGIC = "%PDF-";

interface TestDepsOverrides {
  readFileContent?: string;
  readFileThrows?: Error;
  writeFileThrows?: Error;
}

function makeDeps(overrides: TestDepsOverrides = {}) {
  const readContent = overrides.readFileContent ?? "# hello\n\n```typediagram\ntype X { a: Int }\n```\n";
  const readFile = vi.fn(() => {
    if (overrides.readFileThrows) {
      return Promise.reject(overrides.readFileThrows);
    }
    return Promise.resolve(new TextEncoder().encode(readContent));
  });
  const writeFile = vi.fn(() => {
    if (overrides.writeFileThrows) {
      return Promise.reject(overrides.writeFileThrows);
    }
    return Promise.resolve();
  });
  const showInformationMessage = vi.fn(() => Promise.resolve(undefined));
  const showErrorMessage = vi.fn();
  const openExternal = vi.fn(() => Promise.resolve(true));
  const executeCommand = vi.fn(() => Promise.resolve(undefined));
  const uriWithPath = vi.fn((_base: { path: string }, newPath: string) => ({
    path: newPath,
    scheme: "file",
    toString: () => `file://${newPath}`,
  }));

  return {
    deps: {
      readFile: readFile as unknown as ExportPdfDeps["readFile"],
      writeFile: writeFile as unknown as ExportPdfDeps["writeFile"],
      uriWithPath: uriWithPath as unknown as ExportPdfDeps["uriWithPath"],
      showInformationMessage: showInformationMessage as unknown as ExportPdfDeps["showInformationMessage"],
      showErrorMessage,
      openExternal: openExternal as unknown as ExportPdfDeps["openExternal"],
      executeCommand: executeCommand as unknown as ExportPdfDeps["executeCommand"],
    },
    spies: {
      readFile,
      writeFile,
      showInformationMessage,
      showErrorMessage,
      openExternal,
      executeCommand,
      uriWithPath,
    },
  };
}

const SAMPLE_URI = {
  path: "/repo/packages/vscode/examples/spec.md",
  scheme: "file",
  toString: () => "file:///repo/packages/vscode/examples/spec.md",
} as unknown as vscodeTypes.Uri;

describe("[PDF-COMPOSE] extractSvgs / reinjectSvgs", () => {
  it("replaces every <svg> block with a sentinel and collects them in order", () => {
    const md = "prose\n\n<svg>one</svg>\n\nmore\n\n<svg>two</svg>\n\nend";
    const { skeleton, svgs } = extractSvgs(md);
    expect(skeleton).not.toContain("<svg");
    expect(skeleton).toContain("\uE000TDSVG0\uE001");
    expect(skeleton).toContain("\uE000TDSVG1\uE001");
    expect(svgs).toEqual(["<svg>one</svg>", "<svg>two</svg>"]);
  });

  it("round-trips: reinjectSvgs(extractSvgs(x).skeleton, svgs) === x", () => {
    const md = "a\n<svg>a</svg>\nb\n<svg foo='bar'>multi\nline</svg>\nc";
    const { skeleton, svgs } = extractSvgs(md);
    expect(reinjectSvgs(skeleton, svgs)).toBe(md);
  });

  it("matches multiline SVGs with attributes", () => {
    const md = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">
<rect/>
</svg>`;
    const { svgs } = extractSvgs(md);
    expect(svgs).toHaveLength(1);
    expect(svgs[0]).toContain("<rect/>");
  });

  it("reinjectSvgs throws on unmatched sentinel index", () => {
    expect(() => reinjectSvgs("\uE000TDSVG5\uE001", [])).toThrow(/unmatched sentinel/);
  });

  it("does NOT leak the sentinel token into the final output", () => {
    const md = "<svg>x</svg>";
    const { skeleton, svgs } = extractSvgs(md);
    const out = reinjectSvgs(skeleton, svgs);
    expect(out).not.toContain("\uE000");
    expect(out).not.toContain("TDSVG");
  });

  it("splits text around sentinel markers and keeps surrounding prose", () => {
    const parts = splitSentinelText(`before ${"\uE000TDSVG2\uE001"} after`);
    expect(parts).toEqual([
      { kind: "text", value: "before " },
      { kind: "svg", value: 2 },
      { kind: "text", value: " after" },
    ]);
  });

  it("returns a single text part when no sentinel is present", () => {
    expect(splitSentinelText("plain only")).toEqual([{ kind: "text", value: "plain only" }]);
  });

  it("returns a single text part for the empty string", () => {
    expect(splitSentinelText("")).toEqual([{ kind: "text", value: "" }]);
  });
});

describe("[PDF-SHELL] buildShell", () => {
  it("produces a self-contained HTML doc with @page A4 20mm", () => {
    const html = buildShell("my doc", "<p>hi</p>");
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain("@page { size: A4; margin: 20mm; }");
    expect(html).toContain("<p>hi</p>");
    expect(html).toContain("<title>my doc</title>");
  });

  it("references NO external stylesheets, scripts, or fonts", () => {
    const html = buildShell("t", "<p>x</p>");
    expect(html).not.toMatch(/<link[^>]+href=["']https?:/);
    expect(html).not.toMatch(/<script[^>]+src=["']https?:/);
    expect(html).not.toMatch(/@import\s+url\(https?:/);
    expect(html).not.toMatch(/@font-face[^}]*src:\s*url\(https?:/);
  });

  it("escapes the title so a malicious filename can't break out", () => {
    const html = buildShell("</title><script>alert(1)</script>", "<p/>");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;/title&gt;");
  });
});

describe("[PDF-COMPOSE] composeHtml", () => {
  beforeAll(async () => {
    await warmupSyncRender();
  });

  it("passes through markdown with zero typediagram fences", () => {
    const { html, fenceCount } = composeHtml("# hi\n\nparagraph\n", { theme: "light", title: "t" });
    expect(fenceCount).toBe(0);
    expect(html).toContain("<h1>hi</h1>");
    expect(html).toContain("<p>paragraph</p>");
    expect(html).not.toContain("<svg");
  });

  it("inlines an SVG for each typediagram fence (no html-escaping of the SVG)", () => {
    const md = "intro\n\n```typediagram\ntype X { a: Int }\n```\n\nouttro\n";
    const { html, fenceCount } = composeHtml(md, { theme: "light", title: "t" });
    expect(fenceCount).toBe(1);
    expect(html).toContain("<svg");
    expect(html).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(html).not.toContain("&lt;svg");
    expect(html).not.toContain("```typediagram");
    expect(html).toContain("intro");
    expect(html).toContain("outtro");
  });

  it("produces different output for light vs dark when a fence is present", () => {
    const md = "```typediagram\ntype X { a: Int }\n```";
    const lightHtml = composeHtml(md, { theme: "light", title: "t" }).html;
    const darkHtml = composeHtml(md, { theme: "dark", title: "t" }).html;
    expect(lightHtml).not.toBe(darkHtml);
  });

  it("surfaces diagnostics for a bad fence and still returns an html string", () => {
    const md = "```typediagram\ntype X { @bad }\n```";
    const result = composeHtml(md, { theme: "light", title: "t" });
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(typeof result.html).toBe("string");
  });
});

describe("[PDF-READ] readMarkdown", () => {
  it("reads bytes and decodes UTF-8", async () => {
    const { deps, spies } = makeDeps({ readFileContent: "# héllo ✨\n" });
    const src = await readMarkdown(SAMPLE_URI, deps);
    expect(src).toBe("# héllo ✨\n");
    expect(spies.readFile).toHaveBeenCalledWith(SAMPLE_URI);
  });

  it("rejects when the file cannot be read", async () => {
    const { deps } = makeDeps({ readFileThrows: new Error("ENOENT") });
    await expect(readMarkdown(SAMPLE_URI, deps)).rejects.toThrow(/ENOENT/);
  });
});

describe("[PDF-RENDER] renderMarkdownToPdf", () => {
  beforeAll(async () => {
    await warmupSyncRender();
  });

  it("returns a real PDF with vector operators for diagrams", async () => {
    const md = "# Export Test\n\n```typediagram\ntype X { a: Int }\n```\n";
    const rendered = await renderMarkdownToPdf(md, { theme: "light", title: "export-test" });
    const prefix = new TextDecoder().decode(rendered.pdf.slice(0, 5));
    const latin = Buffer.from(rendered.pdf).toString("latin1");
    expect(prefix).toBe(PDF_MAGIC);
    expect(rendered.pdf.length).toBeGreaterThan(1024);
    expect(rendered.fenceCount).toBe(1);
    expect(latin).toMatch(/ m\b| l\b| re\b/);
    expect(latin).not.toContain("/Subtype /Image");
  });

  it("changes the rendered bytes when the diagram theme changes", async () => {
    const md = "```typediagram\ntype X { a: Int }\n```";
    const light = await renderMarkdownToPdf(md, { theme: "light", title: "light" });
    const dark = await renderMarkdownToPdf(md, { theme: "dark", title: "dark" });
    expect(Buffer.compare(Buffer.from(light.pdf), Buffer.from(dark.pdf))).not.toBe(0);
  });

  it("renders smaller heading levels without crashing", async () => {
    const md = "#### Small heading\n\nbody";
    const rendered = await renderMarkdownToPdf(md, { theme: "light", title: "small-heading" });
    expect(new TextDecoder().decode(rendered.pdf.slice(0, 5))).toBe(PDF_MAGIC);
  });

  it("renders ordered lists that start at the default index", async () => {
    const md = "1. first\n2. second\n";
    const rendered = await renderMarkdownToPdf(md, { theme: "light", title: "ordered-default" });
    expect(new TextDecoder().decode(rendered.pdf.slice(0, 5))).toBe(PDF_MAGIC);
  });

  it("surfaces diagnostics and still returns a PDF for bad fences", async () => {
    const md = "# Broken\n\n```typediagram\ntype X { @bad }\n```\n";
    const rendered = await renderMarkdownToPdf(md, { theme: "light", title: "broken" });
    expect(rendered.diagnostics.length).toBeGreaterThan(0);
    expect(new TextDecoder().decode(rendered.pdf.slice(0, 5))).toBe(PDF_MAGIC);
  });

  it("renders lists, quotes, rules, hard breaks, and enough content to span multiple pages", async () => {
    const longParagraph = "Long paragraph ".repeat(120);
    const md = [
      "# Structured",
      "",
      "- bullet one",
      "- bullet two",
      "",
      "3. ordered three",
      "4. ordered four",
      "",
      "> quoted line",
      "",
      "paragraph with two spaces  ",
      "line break",
      "",
      "---",
      "",
      "    indented code block",
      "",
      "```ts",
      "const x = 1;",
      "```",
      "",
      longParagraph,
      "",
      longParagraph,
      "",
      longParagraph,
      "",
    ].join("\n");
    const rendered = await renderMarkdownToPdf(md, { theme: "light", title: "structured" });
    const latin = Buffer.from(rendered.pdf).toString("latin1");
    const pageCount = (latin.match(/\/Type\s*\/Page\b/g) ?? []).length;
    expect(new TextDecoder().decode(rendered.pdf.slice(0, 5))).toBe(PDF_MAGIC);
    expect(pageCount).toBeGreaterThan(1);
  });

  it("renders heading-adjacent diagrams before thematic breaks as vector content", async () => {
    const md = [
      "## 8. Notifications",
      "",
      "Reminders for due tasks. Permission flow and delivery channels.",
      "",
      "```typediagram",
      "typeDiagram",
      "",
      "type NotificationPrefs {",
      "  enabled:        Bool",
      "  remind_before:  List<ReminderOffset>",
      "  channels:       List<NotificationChannel>",
      "  quiet_hours:    Option<QuietHours>",
      "}",
      "",
      "union ReminderOffset {",
      "  AtDueTime",
      "  Minutes { value: Int }",
      "  Hours   { value: Int }",
      "  Days    { value: Int }",
      "}",
      "",
      "union NotificationChannel {",
      "  Browser",
      "  System",
      "  Email { address: EmailAddress }",
      "}",
      "",
      "type QuietHours {",
      "  start: TimeOfDay",
      "  end:   TimeOfDay",
      "}",
      "",
      "union PermissionStatus {",
      "  Granted",
      "  Denied",
      "  Default",
      "  Unsupported",
      "}",
      "",
      "alias EmailAddress = String",
      "alias TimeOfDay    = String",
      "```",
      "",
      "---",
      "",
      "## 9. Theming & Visual Tokens",
      "",
    ].join("\n");
    const rendered = await renderMarkdownToPdf(md, { theme: "light", title: "notifications" });
    const latin = Buffer.from(rendered.pdf).toString("latin1");
    expect(new TextDecoder().decode(rendered.pdf.slice(0, 5))).toBe(PDF_MAGIC);
    expect(rendered.fenceCount).toBe(1);
    expect(latin).toMatch(/ m\b| l\b| re\b/);
  });

  it("handles raw SVG width/height, fallback sizing, and unknown sentinel-like text", async () => {
    const md = [
      "before literal sentinel",
      "",
      "\uE000TDSVG9\uE001",
      "",
      '<svg width="120" height="40"><rect width="120" height="40"/></svg>',
      "",
      "<svg><rect/></svg>",
      "",
      '<svg width="120 height="40"><rect/></svg>',
      "",
    ].join("\n");
    const rendered = await renderMarkdownToPdf(md, { theme: "light", title: "raw-svgs" });
    const latin = Buffer.from(rendered.pdf).toString("latin1");
    expect(new TextDecoder().decode(rendered.pdf.slice(0, 5))).toBe(PDF_MAGIC);
    expect(latin).toMatch(/ m\b| l\b| re\b/);
  });
});

describe("[PDF-RENDER] helper coverage", () => {
  it("inlineText handles softbreaks, hardbreaks, and missing children", () => {
    expect(pdfRenderTestUtils.inlineText(undefined)).toBe("");
    expect(pdfRenderTestUtils.inlineText({ content: "fallback" } as never)).toBe("fallback");
    expect(
      pdfRenderTestUtils.inlineText({
        children: [
          { type: "text", content: "a" },
          { type: "softbreak", content: "" },
          { type: "text", content: "b" },
          { type: "hardbreak", content: "" },
          { type: "text", content: "c" },
        ],
      } as never)
    ).toBe("a\nb\nc");
  });

  it("normaliseText collapses excessive blank lines", () => {
    expect(pdfRenderTestUtils.normaliseText("a\n\n\nb\n")).toBe("a\n\nb");
  });

  it("readSvgAttribute handles missing and malformed attributes", () => {
    expect(pdfRenderTestUtils.readSvgAttribute('<svg width="10">', "height")).toBeUndefined();
    expect(pdfRenderTestUtils.readSvgAttribute('<svg width="10></svg', "width")).toBeUndefined();
    expect(pdfRenderTestUtils.readSvgAttribute('<svg width="10" height="20">', "width")).toBe("10");
  });

  it("svgSize prefers viewBox, then width/height, then a fallback size", () => {
    expect(pdfRenderTestUtils.svgSize('<svg viewBox="0 0 120 40"></svg>')).toEqual({ width: 120, height: 40 });
    expect(pdfRenderTestUtils.svgSize('<svg width="80" height="30"></svg>')).toEqual({ width: 80, height: 30 });
    expect(pdfRenderTestUtils.svgSize("<svg></svg>")).toEqual({ width: 640, height: 320 });
  });
});

describe("[PDF-SAVE] siblingPdfPath + writeNextToSource", () => {
  it("maps foo.md → foo.pdf", () => {
    expect(siblingPdfPath("/a/b/foo.md")).toBe("/a/b/foo.pdf");
  });

  it("maps foo.MARKDOWN → foo.pdf (case-insensitive)", () => {
    expect(siblingPdfPath("/a/b/foo.MARKDOWN")).toBe("/a/b/foo.pdf");
  });

  it("writes the buffer to the sibling URI and returns it", async () => {
    const { deps, spies } = makeDeps();
    const buf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
    const result = await writeNextToSource(buf, SAMPLE_URI, deps);
    expect(result.path).toBe("/repo/packages/vscode/examples/spec.pdf");
    expect(spies.writeFile).toHaveBeenCalledTimes(1);
    expect(spies.writeFile.mock.calls[0]?.[1]).toBe(buf);
  });
});

describe("exportPdf composer", () => {
  beforeAll(async () => {
    await warmupSyncRender();
  });

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("runs read → render → save in order and notifies", async () => {
    const { deps, spies } = makeDeps();
    await exportPdf(SAMPLE_URI, { theme: "light" }, deps);
    expect(spies.readFile).toHaveBeenCalledTimes(1);
    expect(spies.writeFile).toHaveBeenCalledTimes(1);
    const writeArgs = spies.writeFile.mock.calls[0] as [unknown, Uint8Array];
    expect((writeArgs[0] as { path: string }).path).toBe("/repo/packages/vscode/examples/spec.pdf");
    expect(new TextDecoder().decode(writeArgs[1].slice(0, 5))).toBe(PDF_MAGIC);
    expect(spies.showInformationMessage).toHaveBeenCalledTimes(1);
  });

  it("opens the saved PDF when the user picks Open PDF", async () => {
    const { deps, spies } = makeDeps();
    spies.showInformationMessage.mockResolvedValueOnce("Open PDF");
    await exportPdf(SAMPLE_URI, { theme: "light" }, deps);
    expect(spies.openExternal).toHaveBeenCalledTimes(1);
    expect(spies.executeCommand).not.toHaveBeenCalled();
  });

  it("reveals the saved PDF when the user picks Reveal in File Explorer", async () => {
    const { deps, spies } = makeDeps();
    spies.showInformationMessage.mockResolvedValueOnce("Reveal in File Explorer");
    await exportPdf(SAMPLE_URI, { theme: "light" }, deps);
    expect(spies.executeCommand).toHaveBeenCalledWith("revealFileInOS", expect.anything());
    expect(spies.openExternal).not.toHaveBeenCalled();
  });

  it("surfaces errors through showErrorMessage", async () => {
    const { deps, spies } = makeDeps({ readFileThrows: new Error("ENOENT fake") });
    await exportPdf(SAMPLE_URI, { theme: "light" }, deps);
    expect(spies.showErrorMessage).toHaveBeenCalledTimes(1);
    expect(String(spies.showErrorMessage.mock.calls[0]?.[0])).toContain("ENOENT fake");
  });

  it("serializes concurrent exports for the same URI", async () => {
    let unblock!: () => void;
    const readFile = vi.fn(
      () =>
        new Promise<Uint8Array>((resolve) => {
          unblock = () => resolve(new TextEncoder().encode("# hi"));
        })
    );
    const { deps, spies } = makeDeps();
    const delayedDeps = { ...deps, readFile: readFile as unknown as ExportPdfDeps["readFile"] };
    const first = exportPdf(SAMPLE_URI, { theme: "light" }, delayedDeps);
    const second = exportPdf(SAMPLE_URI, { theme: "light" }, delayedDeps);
    unblock();
    await Promise.all([first, second]);
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(spies.writeFile).toHaveBeenCalledTimes(1);
  });
});
