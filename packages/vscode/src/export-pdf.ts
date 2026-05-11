import type * as vscode from "vscode";
import { getLogger } from "./logger.js";
import { renderMarkdownToPdf } from "./pdf-render.js";

export { buildShell, composeHtml, composeSvgMarkdown, extractSvgs, reinjectSvgs, splitSentinelText } from "./pdf-compose.js";
export type { ComposeResult, PdfDiagnostic, Theme } from "./pdf-compose.js";

export interface ExportPdfDeps {
  readonly readFile: (uri: vscode.Uri) => Promise<Uint8Array>;
  readonly writeFile: (uri: vscode.Uri, data: Uint8Array) => Promise<void>;
  readonly uriWithPath: (base: vscode.Uri, newPath: string) => vscode.Uri;
  readonly showInformationMessage: (msg: string, ...actions: string[]) => Promise<string | undefined>;
  readonly showErrorMessage: (msg: string) => void;
  readonly openExternal: (uri: vscode.Uri) => Promise<boolean>;
  readonly executeCommand: (cmd: string, ...args: unknown[]) => Promise<unknown>;
}

export async function readMarkdown(uri: vscode.Uri, deps: Pick<ExportPdfDeps, "readFile">) {
  const bytes = await deps.readFile(uri);
  return new TextDecoder("utf-8").decode(bytes);
}

const MD_EXT_RE = /\.(md|markdown)$/i;

export function siblingPdfPath(sourcePath: string) {
  if (MD_EXT_RE.test(sourcePath)) {
    return sourcePath.replace(MD_EXT_RE, ".pdf");
  }
  return `${sourcePath}.pdf`;
}

export async function writeNextToSource(
  buf: Uint8Array,
  sourceUri: vscode.Uri,
  deps: Pick<ExportPdfDeps, "writeFile" | "uriWithPath">
) {
  const target = deps.uriWithPath(sourceUri, siblingPdfPath(sourceUri.path));
  await deps.writeFile(target, buf);
  return target;
}

const inFlight = new Map<string, Promise<void>>();

export async function exportPdf(
  sourceUri: vscode.Uri,
  opts: { theme: "light" | "dark" },
  deps: ExportPdfDeps
) {
  const log = getLogger().child({ scope: "export-pdf" });
  const key = sourceUri.toString();
  const existing = inFlight.get(key);
  if (existing) {
    log.warn("export-pdf already in progress for URI, awaiting existing", { uri: key });
    await existing;
    return;
  }
  const run = runExport(sourceUri, opts, deps, log);
  inFlight.set(key, run);
  try {
    await run;
  } finally {
    inFlight.delete(key);
  }
}

async function runExport(
  sourceUri: vscode.Uri,
  opts: { theme: "light" | "dark" },
  deps: ExportPdfDeps,
  log: ReturnType<typeof getLogger>
) {
  log.info("export-pdf invoked", { uri: sourceUri.toString() });
  try {
    const t0 = Date.now();
    const src = await readMarkdown(sourceUri, deps);
    const title = titleFromPath(sourceUri.path);
    const rendered = await renderMarkdownToPdf(src, { theme: opts.theme, title });
    log.info("rendered PDF", {
      bufferLength: rendered.pdf.length,
      fenceCount: rendered.fenceCount,
      diagnostics: rendered.diagnostics.length,
      elapsedMs: Date.now() - t0,
    });
    const saved = await writeNextToSource(rendered.pdf, sourceUri, deps);
    log.info("saved PDF", { savedUri: saved.toString() });
    notifySaved(saved, deps, log);
  } catch (err) {
    log.error("export-pdf failed", { err: String(err) });
    deps.showErrorMessage(`TypeDiagram: PDF export failed — ${String(err)}`);
  }
}

function titleFromPath(path: string) {
  const parts = path.split("/");
  const basename = parts[parts.length - 1] as string;
  return basename.replace(MD_EXT_RE, "");
}

function notifySaved(saved: vscode.Uri, deps: ExportPdfDeps, log: ReturnType<typeof getLogger>) {
  void deps
    .showInformationMessage(`TypeDiagram PDF written: ${saved.path}`, "Open PDF", "Reveal in File Explorer")
    .then(
      (choice) => {
        if (choice === "Open PDF") {
          void deps.openExternal(saved);
        } else if (choice === "Reveal in File Explorer") {
          void deps.executeCommand("revealFileInOS", saved);
        }
        log.info("notification dismissed", { choice: choice ?? "(none)" });
      },
      (err: unknown) => {
        log.error("notification failed", { err: String(err) });
      }
    );
}
