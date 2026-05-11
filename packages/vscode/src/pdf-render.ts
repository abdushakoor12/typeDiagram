import MarkdownIt from "markdown-it";
import PDFDocument from "pdfkit";
import SVGtoPDFUntyped from "svg-to-pdfkit";
import { composeSvgMarkdown, splitSentinelText, type PdfDiagnostic, type Theme } from "./pdf-compose.js";

type SVGtoPDFFn = (
  doc: PDFKit.PDFDocument,
  svg: string,
  x: number,
  y: number,
  options?: { width?: number; height?: number; assumePt?: boolean }
) => void;

type MarkdownToken = ReturnType<MarkdownIt["parse"]>[number];

interface RenderPdfResult {
  pdf: Uint8Array;
  fenceCount: number;
  diagnostics: ReadonlyArray<PdfDiagnostic>;
}

interface RenderState {
  doc: PDFKit.PDFDocument;
  svgs: string[];
  listStack: Array<{ kind: "bullet" } | { kind: "ordered"; next: number }>;
  pendingListMarker?: string;
}

const SVGtoPDF: SVGtoPDFFn = SVGtoPDFUntyped as unknown as SVGtoPDFFn;
const PDF_MARGIN = 56;
const CONTENT_WIDTH = 595.28 - PDF_MARGIN * 2;
const MAX_DIAGRAM_HEIGHT = 260;

export async function renderMarkdownToPdf(
  mdSource: string,
  opts: { theme: Theme; title: string }
): Promise<RenderPdfResult> {
  const composed = composeSvgMarkdown(mdSource, opts.theme);
  const md = new MarkdownIt({ html: false, linkify: true, typographer: false });
  const tokens = md.parse(composed.skeleton, {});
  const doc = new PDFDocument({
    size: "A4",
    margin: PDF_MARGIN,
    info: { Title: opts.title },
    compress: false,
  });
  const state: RenderState = { doc, svgs: composed.svgs, listStack: [] };
  const pdf = bufferFromStream(doc);
  renderTokens(tokens, state);
  doc.end();
  return {
    pdf: await pdf,
    fenceCount: composed.svgs.length,
    diagnostics: composed.diagnostics,
  };
}

function renderTokens(tokens: MarkdownToken[], state: RenderState) {
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.type === "heading_open") {
      i = renderHeading(tokens, i, state);
    } else if (token.type === "paragraph_open") {
      i = renderParagraph(tokens, i, state);
    } else if (token.type === "bullet_list_open") {
      state.listStack.push({ kind: "bullet" });
    } else if (token.type === "ordered_list_open") {
      state.listStack.push({ kind: "ordered", next: Number(token.attrGet("start") ?? "1") });
    } else if (token.type === "bullet_list_close" || token.type === "ordered_list_close") {
      state.listStack.pop();
      addGap(state.doc, 6);
    } else if (token.type === "list_item_open") {
      state.pendingListMarker = nextListMarker(state.listStack[state.listStack.length - 1] as RenderState["listStack"][number]);
    } else if (token.type === "list_item_close") {
      state.pendingListMarker = undefined;
      addGap(state.doc, 4);
    } else if (token.type === "fence" || token.type === "code_block") {
      renderCodeBlock(token.content, state);
    } else if (token.type === "blockquote_open") {
      addGap(state.doc, 4);
    } else if (token.type === "blockquote_close") {
      addGap(state.doc, 8);
    } else if (token.type === "hr") {
      renderRule(state);
    }
  }
}

function renderHeading(tokens: MarkdownToken[], start: number, state: RenderState) {
  const inline = tokens[start + 1];
  const level = Number(tokens[start].tag.slice(1));
  const fontSize = [24, 20, 16, 14, 12, 11][Math.max(0, Math.min(level - 1, 5))] as number;
  renderInlineParts(splitSentinelText(inlineText(inline)), state, {
    font: "Helvetica-Bold",
    fontSize,
    gapAfter: level <= 2 ? 10 : 8,
  });
  return start + 2;
}

function renderParagraph(tokens: MarkdownToken[], start: number, state: RenderState) {
  const inline = tokens[start + 1];
  renderInlineParts(splitSentinelText(inlineText(inline)), state, {
    font: "Helvetica",
    fontSize: 11,
    gapAfter: 8,
  });
  return start + 2;
}

function renderInlineParts(
  parts: ReturnType<typeof splitSentinelText>,
  state: RenderState,
  opts: { font: string; fontSize: number; gapAfter: number }
) {
  for (const part of parts) {
    if (part.kind === "text" && part.value.trim().length > 0) {
      renderText(part.value, state, opts);
    } else if (part.kind === "svg") {
      renderSvg(state.svgs[part.value], state);
    }
  }
}

function renderText(
  text: string,
  state: RenderState,
  opts: { font: string; fontSize: number; gapAfter: number }
) {
  const indent = state.listStack.length > 0 ? state.listStack.length * 18 : 0;
  const marker = state.pendingListMarker;
  const prefix = marker ? `${marker} ` : "";
  const width = CONTENT_WIDTH - indent - (marker ? 16 : 0);
  const content = `${prefix}${normaliseText(text)}`;
  const height = state.doc.heightOfString(content, { width, lineGap: 3 });
  ensureVerticalSpace(state.doc, height + opts.gapAfter);
  state.doc.font(opts.font).fontSize(opts.fontSize).fillColor("#111");
  state.doc.text(content, PDF_MARGIN + indent, state.doc.y, { width, lineGap: 3 });
  state.pendingListMarker = undefined;
  addGap(state.doc, opts.gapAfter);
}

function renderCodeBlock(content: string, state: RenderState) {
  const text = content.trimEnd();
  const padding = 10;
  const width = CONTENT_WIDTH;
  state.doc.font("Courier").fontSize(10);
  const height = state.doc.heightOfString(text, { width: width - padding * 2, lineGap: 2 }) + padding * 2;
  ensureVerticalSpace(state.doc, height + 8);
  const x = PDF_MARGIN;
  const y = state.doc.y;
  state.doc.roundedRect(x, y, width, height, 4).fill("#f4f4f6");
  state.doc.fillColor("#111");
  state.doc.text(text, x + padding, y + padding, { width: width - padding * 2, lineGap: 2 });
  state.doc.y = y + height;
  addGap(state.doc, 8);
}

function renderSvg(svg: string | undefined, state: RenderState) {
  if (!svg) {
    return;
  }
  const size = svgSize(svg);
  const scale = Math.min(CONTENT_WIDTH / size.width, MAX_DIAGRAM_HEIGHT / size.height);
  const width = size.width * scale;
  const height = size.height * scale;
  ensureVerticalSpace(state.doc, height + 12);
  SVGtoPDF(state.doc, svg, PDF_MARGIN, state.doc.y, { width, height, assumePt: false });
  state.doc.y += height;
  addGap(state.doc, 12);
}

function renderRule(state: RenderState) {
  ensureVerticalSpace(state.doc, 16);
  const y = state.doc.y + 4;
  state.doc.moveTo(PDF_MARGIN, y).lineTo(PDF_MARGIN + CONTENT_WIDTH, y).strokeColor("#d9d9de").stroke();
  state.doc.y = y + 6;
}

function nextListMarker(entry: RenderState["listStack"][number]) {
  if (entry.kind === "bullet") {
    return "•";
  }
  const marker = `${entry.next}.`;
  entry.next += 1;
  return marker;
}

function ensureVerticalSpace(doc: PDFKit.PDFDocument, required: number) {
  const bottom = doc.page.height - doc.page.margins.bottom;
  if (doc.y + required > bottom) {
    doc.addPage();
  }
}

function addGap(doc: PDFKit.PDFDocument, amount: number) {
  doc.y += amount;
}

function inlineText(token: MarkdownToken | undefined) {
  const childText = (token?.children ?? [])
    .map((child) => {
      if (child.type === "softbreak" || child.type === "hardbreak") {
        return "\n";
      }
      return child.content;
    })
    .join("");
  return childText.length > 0 ? childText : (token?.content ?? "");
}

function normaliseText(text: string) {
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

function svgSize(svg: string) {
  const openTag = String(svg.split(">")[0]);
  const viewBox = readSvgAttribute(openTag, "viewBox");
  const viewBoxParts = viewBox?.trim().split(/\s+/).map(Number) ?? [];
  if (viewBoxParts.length === 4 && viewBoxParts[2] > 0 && viewBoxParts[3] > 0) {
    return { width: viewBoxParts[2], height: viewBoxParts[3] };
  }
  const width = Number.parseFloat(readSvgAttribute(openTag, "width") ?? "");
  const height = Number.parseFloat(readSvgAttribute(openTag, "height") ?? "");
  if (width > 0 && height > 0) {
    return { width, height };
  }
  return { width: 640, height: 320 };
}

function readSvgAttribute(tag: string, name: string) {
  const marker = `${name}="`;
  const start = tag.indexOf(marker);
  if (start < 0) {
    return undefined;
  }
  const valueStart = start + marker.length;
  const end = tag.indexOf('"', valueStart);
  return end < 0 ? undefined : tag.slice(valueStart, end);
}

function bufferFromStream(doc: PDFKit.PDFDocument): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
    doc.on("error", reject);
  });
}

export const pdfRenderTestUtils = {
  inlineText,
  normaliseText,
  readSvgAttribute,
  svgSize,
};
