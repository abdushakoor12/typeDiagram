const assert = require("node:assert");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const vscode = require("vscode");

suite("typediagram extension inside a real VS Code", () => {
  const candidateIds = ["nimblesite.typediagram", "nimblesite.typediagram-vscode"];
  const findExt = () => candidateIds.map((id) => vscode.extensions.getExtension(id)).find(Boolean);

  test("extension is installed and activatable", async () => {
    const ext = findExt();
    assert.ok(ext, `none of ${candidateIds.join(", ")} found`);
    await ext.activate();
    assert.strictEqual(ext.isActive, true);
  });

  test("package.json declares markdown injection grammar and markdown-it plugin", () => {
    const ext = findExt();
    assert.ok(ext);
    const contributes = ext.packageJSON.contributes;
    assert.ok(contributes);
    const grammars = contributes.grammars ?? [];
    const injection = grammars.find((g) => g.scopeName === "markdown.typediagram.codeblock");
    assert.ok(injection, "injection grammar not declared");
    assert.ok((injection.injectTo ?? []).includes("text.html.markdown"), "not injecting into markdown");
    assert.strictEqual(contributes["markdown.markdownItPlugins"], true, "markdownItPlugins flag not set");
  });

  test("exportMarkdownPdf writes a real PDF in desktop VS Code and diagrams add content", async function () {
    this.timeout(60_000);
    const ext = findExt();
    assert.ok(ext);
    await ext.activate();

    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "typediagram-electron-"));
    const plainPath = path.join(tmpRoot, "plain.md");
    const diagramPath = path.join(tmpRoot, "diagram.md");
    const plainPdf = path.join(tmpRoot, "plain.pdf");
    const diagramPdf = path.join(tmpRoot, "diagram.pdf");

    await fs.writeFile(plainPath, "# Plain\n\nJust text.\n", "utf8");
    await fs.writeFile(
      diagramPath,
      "# Diagram\n\n```typediagram\ntype X { a: Int }\n```\n",
      "utf8"
    );

    const plainUri = vscode.Uri.file(plainPath);
    const diagramUri = vscode.Uri.file(diagramPath);
    await vscode.workspace.openTextDocument(plainUri).then((doc) => vscode.window.showTextDocument(doc));
    await vscode.commands.executeCommand("typediagram.exportMarkdownPdf", plainUri);
    await vscode.commands.executeCommand("typediagram.exportMarkdownPdf", diagramUri);

    const plainBytes = await waitForPdf(plainPdf);
    const diagramBytes = await waitForPdf(diagramPdf);
    assert.strictEqual(plainBytes.subarray(0, 5).toString("latin1"), "%PDF-");
    assert.strictEqual(diagramBytes.subarray(0, 5).toString("latin1"), "%PDF-");
    assert.ok(diagramBytes.length > plainBytes.length, "diagram PDF should contain more content than plain text PDF");
  });
});

async function waitForPdf(pdfPath) {
  for (let i = 0; i < 80; i += 1) {
    try {
      const buf = await fs.readFile(pdfPath);
      if (buf.length > 5) {
        return buf;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out waiting for ${pdfPath}`);
}
