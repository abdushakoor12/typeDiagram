import MarkdownIt from "markdown-it";
import { renderMarkdownSync } from "typediagram-core/markdown";

export type Theme = "light" | "dark";

export interface PdfDiagnostic {
  line: number;
  col: number;
  severity: string;
  message: string;
}

export interface ComposeResult {
  html: string;
  fenceCount: number;
  diagnostics: ReadonlyArray<PdfDiagnostic>;
}

export interface SvgMarkdown {
  skeleton: string;
  svgs: string[];
  diagnostics: ReadonlyArray<PdfDiagnostic>;
}

const SENTINEL_PREFIX = "\uE000TDSVG";
const SENTINEL_SUFFIX = "\uE001";
const SENTINEL_RE = /\uE000TDSVG(\d+)\uE001/g;
const SVG_BLOCK_RE = /<svg\b[\s\S]*?<\/svg>/gi;

export function buildShell(title: string, bodyHtml: string) {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
@page { size: A4; margin: 20mm; }
html, body { background: #fff; color: #111; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  font-size: 11pt;
  line-height: 1.5;
  margin: 0;
}
h1, h2, h3, h4, h5, h6 { line-height: 1.2; margin-top: 1.2em; }
code, pre {
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, "Courier New", monospace;
  font-size: 10pt;
}
pre { background: #f4f4f6; padding: 0.75em 1em; border-radius: 4px; overflow-x: auto; }
pre code { background: none; padding: 0; }
code { background: #f4f4f6; padding: 0.1em 0.3em; border-radius: 3px; }
.typediagram { page-break-inside: avoid; margin: 1em 0; }
.typediagram svg { max-width: 100%; height: auto; }
a { color: #0366d6; }
table { border-collapse: collapse; }
th, td { border: 1px solid #ddd; padding: 0.4em 0.6em; }
</style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
}

export function extractSvgs(mdWithSvgs: string) {
  const svgs: string[] = [];
  const skeleton = mdWithSvgs.replace(SVG_BLOCK_RE, (match) => {
    const i = svgs.length;
    svgs.push(match);
    return `${SENTINEL_PREFIX}${String(i)}${SENTINEL_SUFFIX}`;
  });
  return { skeleton, svgs };
}

export function reinjectSvgs(html: string, svgs: string[]) {
  return html.replace(SENTINEL_RE, (_m, idx: string) => {
    const n = Number(idx);
    const svg = svgs[n];
    if (svg === undefined) {
      throw new Error(`[PDF-COMPOSE] unmatched sentinel index ${idx}`);
    }
    return svg;
  });
}

export function composeSvgMarkdown(mdSource: string, theme: Theme): SvgMarkdown {
  const rendered = renderMarkdownSync(mdSource, { theme });
  const mdWithSvgs = rendered.ok ? rendered.value : mdSource;
  const diagnostics = rendered.ok ? [] : rendered.error;
  const { skeleton, svgs } = extractSvgs(mdWithSvgs);
  return { skeleton, svgs, diagnostics };
}

export function composeHtml(mdSource: string, opts: { theme: Theme; title: string }): ComposeResult {
  const composed = composeSvgMarkdown(mdSource, opts.theme);
  const md = new MarkdownIt({ html: false, linkify: true, typographer: false });
  const bodyHtml = md.render(composed.skeleton);
  const html = buildShell(opts.title, reinjectSvgs(bodyHtml, composed.svgs));
  return { html, fenceCount: composed.svgs.length, diagnostics: composed.diagnostics };
}

export function splitSentinelText(text: string) {
  const parts: Array<{ kind: "text"; value: string } | { kind: "svg"; value: number }> = [];
  let lastIndex = 0;
  for (const match of text.matchAll(SENTINEL_RE)) {
    const index = match.index as number;
    const raw = match[0];
    const svgIndex = Number(match[1]);
    if (index > lastIndex) {
      parts.push({ kind: "text", value: text.slice(lastIndex, index) });
    }
    parts.push({ kind: "svg", value: svgIndex });
    lastIndex = index + raw.length;
  }
  if (lastIndex < text.length) {
    parts.push({ kind: "text", value: text.slice(lastIndex) });
  }
  if (parts.length === 0) {
    return [{ kind: "text" as const, value: text }];
  }
  return parts;
}

function escapeHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
