import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestRenderer } from "@opentui/core/testing";
import { ReviewController } from "../src/review/controller.mjs";
import { createHighlighter } from "../src/review/highlighting.mjs";
import { parseUnifiedDiff } from "../src/review/parse-diff.mjs";
import { emptyStore, readStore } from "../src/review/store.mjs";
import { ReviewUI } from "../src/review/ui.mjs";

const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

function testModel() {
  return parseUnifiedDiff(
    [
      "diff --git a/src/a.js b/src/a.js",
      "--- a/src/a.js",
      "+++ b/src/a.js",
      "@@ -1,2 +1,3 @@",
      " const before = true;",
      "-const value = 1;",
      "+const value = 2;",
      "+console.log(value);",
    ].join("\n"),
    { generation: 1 },
  );
}

function longModel(lineCount = 40) {
  return parseUnifiedDiff(
    [
      "diff --git a/src/long.js b/src/long.js",
      "--- a/src/long.js",
      "+++ b/src/long.js",
      `@@ -0,0 +1,${lineCount} @@`,
      ...Array.from(
        { length: lineCount },
        (_, index) => `+const line${index + 1} = ${index + 1};`,
      ),
    ].join("\n"),
    { generation: 1 },
  );
}

function longRowModel() {
  return parseUnifiedDiff(
    [
      "diff --git a/src/wrap.js b/src/wrap.js",
      "--- a/src/wrap.js",
      "+++ b/src/wrap.js",
      "@@ -0,0 +1 @@",
      `+const wrapped = "${"long-content-".repeat(12)}";`,
    ].join("\n"),
    { generation: 1 },
  );
}

function revisedValueModel() {
  return parseUnifiedDiff(
    [
      "diff --git a/src/a.js b/src/a.js",
      "--- a/src/a.js",
      "+++ b/src/a.js",
      "@@ -1,2 +1,2 @@",
      " const before = true;",
      "-const value = 2;",
      "+const value = 3;",
    ].join("\n"),
    { generation: 2 },
  );
}

async function setup(
  width = 100,
  height = 24,
  highlighterOverride,
  modelOverride = testModel(),
) {
  const testRenderer = await createTestRenderer({ width, height });
  const stateDir = mkdtempSync(join(tmpdir(), "herdr-ui-"));
  const source = {
    status: async () => ({ fingerprint: "next", entries: [] }),
    refresh: async () => modelOverride,
  };
  const controller = new ReviewController({
    source,
    stateDir,
    store: emptyStore("review-ui", "/repo"),
  });
  controller.model = modelOverride;
  controller.status = "Ready.";
  const highlighter =
    highlighterOverride ?? { highlight: async (value) => value };
  const ui = new ReviewUI(testRenderer.renderer, controller, highlighter);
  await ui.render();
  await testRenderer.flush();
  cleanups.push(async () => testRenderer.renderer.destroy());
  return { ...testRenderer, controller, stateDir, ui };
}

function expectSelectedRowVisible(app) {
  const selected = app.ui.diff.content.findDescendantById(
    `row:${app.controller.row.id}`,
  );
  expect(selected).toBeDefined();
  expect(selected.y).toBeGreaterThanOrEqual(app.ui.diff.viewport.y);
  expect(selected.y + selected.height).toBeLessThanOrEqual(
    app.ui.diff.viewport.y + app.ui.diff.viewport.height,
  );
}

test("addition and deletion rows use distinct full-row backgrounds", async () => {
  const app = await setup();
  const addition = app.controller.file.rows.find(
    (row) => row.kind === "addition",
  );
  const deletion = app.controller.file.rows.find(
    (row) => row.kind === "deletion",
  );
  const additionRow = app.ui.diff.content.findDescendantById(
    `row:${addition.id}`,
  );
  const deletionRow = app.ui.diff.content.findDescendantById(
    `row:${deletion.id}`,
  );

  expect(additionRow.backgroundColor).toBeDefined();
  expect(deletionRow.backgroundColor).toBeDefined();
  expect(additionRow.backgroundColor).not.toEqual(deletionRow.backgroundColor);
  expect(additionRow.width).toBe(app.ui.diff.viewport.width);
  expect(deletionRow.width).toBe(app.ui.diff.viewport.width);
});

test("keyboard navigation, multiline paste, save, cancel, and resize preserve state", async () => {
  const app = await setup();
  expect(app.captureCharFrame()).toContain("uncommitted");

  app.mockInput.pressKey("j");
  await app.flush();
  expect(app.controller.rowIndex).toBe(1);

  app.mockInput.pressKey("c");
  await app.waitFor(() => app.controller.editor != null);
  await app.flush();
  await app.mockInput.pasteBracketedText("Human note\nsecond line");
  await app.flush();
  app.mockInput.pressKey("s", { ctrl: true });
  await app.waitFor(() => app.controller.editor == null);
  await app.flush();
  expect(app.controller.store.notes).toHaveLength(1);
  expect(app.controller.store.notes[0].body).toBe("Human note\nsecond line");
  expect(app.captureCharFrame()).toContain("open comment");
  expect(app.captureCharFrame()).toContain("Human note");
  expect(app.captureCharFrame()).toContain("second line");

  app.mockInput.pressKey("c");
  await app.waitFor(() => app.controller.editor != null);
  await app.mockInput.typeText("unsaved");
  app.resize(80, 18);
  await app.ui.render();
  await app.flush();
  expect(app.ui.editor.plainText).toBe("unsaved");
  app.mockInput.pressEscape();
  await Bun.sleep(50);
  await app.waitFor(() => app.controller.editor == null);
  expect(app.controller.store.notes).toHaveLength(1);

  app.mockInput.pressKey("n");
  await app.flush();
  app.mockInput.pressKey("e");
  await app.waitFor(() => app.controller.editor != null);
  await app.flush();
  app.ui.editor.selectAll();
  await app.mockInput.typeText("Updated human note");
  app.mockInput.pressKey("s", { ctrl: true });
  await app.waitFor(() => app.controller.editor == null);
  expect(app.controller.store.notes[0].body).toBe("Updated human note");

  const rowId = app.controller.row.id;
  app.resize(60, 16);
  await app.ui.render();
  await app.flush();
  expect(app.controller.row.id).toBe(rowId);
  expect(app.ui.files.visible).toBe(false);

  app.mockInput.pressKey("d");
  app.mockInput.pressKey("d");
  await app.waitFor(() => app.controller.store.notes.length === 0);
  expect(app.controller.store.notes).toHaveLength(0);
});

test("sidebar toggles without losing selection and file rows are not text-selectable", async () => {
  const app = await setup();
  const selectedFile = app.controller.file.id;
  const fileRow = app.ui.files.findDescendantById(`file:${selectedFile}`);
  expect(fileRow.selectable).toBe(false);

  app.mockInput.pressKey("b");
  await app.flush();
  expect(app.ui.files.visible).toBe(false);
  expect(app.controller.file.id).toBe(selectedFile);
  expect(app.controller.store.ui.sidebarVisible).toBe(false);

  app.mockInput.pressKey("b");
  await app.flush();
  expect(app.ui.files.visible).toBe(true);
  expect(app.controller.file.id).toBe(selectedFile);
  expect(app.controller.store.ui.sidebarVisible).toBe(true);

  const initialWidth = app.controller.sidebarWidth;
  expect(app.ui.splitter.shouldFill).toBe(false);
  const splitterX = app.ui.splitter.x;
  await app.mockMouse.drag(splitterX, 5, splitterX + 10, 5);
  await app.flush();
  expect(app.controller.sidebarWidth).toBeGreaterThan(initialWidth);
  expect(app.controller.store.ui.sidebarWidth).toBe(
    app.controller.sidebarWidth,
  );
});

test("scope switching isolates comments and persists the active scope", async () => {
  const app = await setup();

  app.mockInput.pressKey("c");
  await app.waitFor(() => app.controller.editor != null);
  await app.mockInput.typeText("Working-tree note");
  app.mockInput.pressKey("s", { ctrl: true });
  await app.waitFor(() => app.controller.editor == null);
  expect(app.controller.notes).toHaveLength(1);
  expect(app.controller.notes[0].scope).toBe("uncommitted");

  app.mockInput.pressKey("2");
  await app.waitFor(() => app.controller.scope === "branch");
  await app.flush();
  expect(app.controller.notes).toHaveLength(0);
  expect(app.controller.store.ui.scope).toBe("branch");

  app.mockInput.pressKey("c");
  await app.waitFor(() => app.controller.editor != null);
  await app.mockInput.typeText("Branch note");
  app.mockInput.pressKey("s", { ctrl: true });
  await app.waitFor(() => app.controller.editor == null);
  expect(app.controller.notes).toHaveLength(1);
  expect(app.controller.notes[0].scope).toBe("branch");
  expect(app.controller.store.notes).toHaveLength(2);

  app.mockInput.pressKey("1");
  await app.waitFor(() => app.controller.scope === "uncommitted");
  await app.flush();
  expect(app.controller.notes.map((note) => note.body)).toEqual([
    "Working-tree note",
  ]);
});

test("x resolves and reopens notes while open detached notes remain visible", async () => {
  const app = await setup();
  app.mockInput.pressKey("c");
  await app.waitFor(() => app.controller.editor != null);
  await app.mockInput.typeText("Verify the fix.");
  app.mockInput.pressKey("s", { ctrl: true });
  await app.waitFor(() => app.controller.editor == null);
  await app.flush();
  const noteId = app.controller.notes[0].id;

  app.mockInput.pressKey("x");
  await app.flush();
  expect(app.controller.store.notes[0].resolvedAt).not.toBeNull();
  expect(app.captureCharFrame()).toContain("resolved comment");

  app.mockInput.pressKey("n");
  await app.flush();
  expect(app.captureCharFrame()).toContain("resolved");
  app.mockInput.pressKey("x");
  await app.flush();
  expect(app.controller.store.notes[0].resolvedAt).toBeNull();

  app.mockInput.pressKey("n");
  app.controller.store.notes[0].status = "stale";
  app.controller.model = { generation: 2, files: [] };
  await app.ui.render();
  await app.flush();
  expect(app.captureCharFrame()).toContain("open · detached");
  expect(app.captureCharFrame()).toContain("Verify the fix.");
  expect(
    app.ui.diff.content.findDescendantById(`detached-note:${noteId}`),
  ).toBeDefined();
  app.mockInput.pressKey("j");
  await app.flush();
  expect(app.ui.selectedDetachedNoteId).toBe(noteId);
  app.mockInput.pressKey("x");
  await app.flush();
  expect(app.controller.store.notes[0].resolvedAt).not.toBeNull();
});

test("a detached note follows a unique former line and participates in j/k navigation", async () => {
  const app = await setup();
  app.controller.rowIndex = app.controller.file.rows.findIndex(
    (row) => row.kind === "addition" && row.text === "const value = 2;",
  );
  app.mockInput.pressKey("c");
  await app.waitFor(() => app.controller.editor != null);
  await app.mockInput.typeText("Keep this behavior.");
  app.mockInput.pressKey("s", { ctrl: true });
  await app.waitFor(() => app.controller.editor == null);
  const note = app.controller.notes[0];
  note.status = "stale";

  app.controller.model = revisedValueModel();
  app.controller.rowIndex = app.controller.file.rows.findIndex(
    (row) => row.kind === "deletion",
  );
  await app.ui.render();
  await app.flush();

  const deletion = app.controller.row;
  const deletionRow = app.ui.diff.content.findDescendantById(
    `row:${deletion.id}`,
  );
  const card = app.ui.diff.content.findDescendantById(
    `detached-note:${note.id}`,
  );
  expect(card).toBeDefined();
  expect(card.y).toBe(deletionRow.y + deletionRow.height);
  expect(
    app.ui.diff.content.findDescendantById("detached-notes-header"),
  ).toBeUndefined();

  app.mockInput.pressKey("j");
  await app.flush();
  expect(app.ui.selectedDetachedNoteId).toBe(note.id);
  expect(
    app.ui.diff.content.findDescendantById(`detached-note:${note.id}`)
      .backgroundColor,
  ).toBeDefined();

  app.mockInput.pressKey("k");
  await app.flush();
  expect(app.ui.selectedDetachedNoteId).toBeNull();
  expect(app.controller.row.id).toBe(deletion.id);
});

test("Russian-layout shortcuts navigate and expose the context comment target", async () => {
  const app = await setup();

  app.mockInput.pressKey("о");
  await app.flush();
  expect(app.controller.rowIndex).toBe(1);

  app.mockInput.pressKey("л");
  await app.flush();
  expect(app.controller.rowIndex).toBe(0);

  app.mockInput.pressKey("ы");
  await app.flush();
  expect(app.controller.preferredSide).toBe("old");
  expect(app.captureCharFrame()).toContain("target:old:1");

  app.mockInput.pressKey("и");
  await app.flush();
  expect(app.ui.files.visible).toBe(false);
});

test("mouse row selection and range drag map to model row indexes", async () => {
  const app = await setup();
  await app.mockMouse.click(45, 4);
  await app.flush();
  expect(app.controller.rowIndex).toBeGreaterThan(0);

  const start = app.controller.rowIndex;
  await app.mockMouse.drag(45, 4, 45, 5);
  await app.flush();
  expect(app.controller.rangeStart).toBe(start);
  expect(app.controller.rowIndex).toBeGreaterThanOrEqual(start);
});

test("j/k navigation keeps the selected row inside a long diff viewport", async () => {
  const app = await setup(80, 12, undefined, longModel());

  await app.mockInput.pressKeys(Array(35).fill("j"));
  await app.waitFor(() => app.controller.rowIndex === 35);
  await app.flush();
  expect(app.ui.diff.scrollTop).toBeGreaterThan(0);
  expectSelectedRowVisible(app);

  await app.mockInput.pressKeys(Array(35).fill("k"));
  await app.waitFor(() => app.controller.rowIndex === 0);
  await app.flush();
  expectSelectedRowVisible(app);
  expect(app.captureCharFrame()).toContain("const line1 = 1;");
});

test("Ctrl+D and Ctrl+U move by half a viewport and keep selection visible", async () => {
  const app = await setup(80, 12, undefined, longModel());

  app.mockInput.pressKey("d", { ctrl: true });
  await app.flush();
  expect(app.controller.rowIndex).toBeGreaterThan(1);
  expectSelectedRowVisible(app);

  app.mockInput.pressKey("u", { ctrl: true });
  await app.flush();
  expect(app.controller.rowIndex).toBe(0);
  expectSelectedRowVisible(app);
});

test("w toggles diff row wrapping and persists the preference", async () => {
  const app = await setup(70, 16, undefined, longRowModel());
  const rowId = app.controller.row.id;
  let row = app.ui.diff.content.findDescendantById(`row:${rowId}`);
  expect(row.height).toBe(1);
  expect(app.controller.store.ui.rowWrap).toBe(false);

  app.mockInput.pressKey("w");
  await app.flush();
  row = app.ui.diff.content.findDescendantById(`row:${rowId}`);
  expect(app.controller.rowWrap).toBe(true);
  expect(app.controller.store.ui.rowWrap).toBe(true);
  expect(readStore(app.stateDir, "review-ui", "/repo").ui.rowWrap).toBe(true);
  expect(row.height).toBeGreaterThan(1);
  expect(row.width).toBeGreaterThanOrEqual(app.ui.diff.viewport.width - 1);
  const code = row.findDescendantById(`code:${rowId}`);
  expect(code.width).toBeGreaterThan(1);
  expect(code.virtualLineCount).toBeGreaterThan(1);
  expect(app.ui.diff.title).toContain("wrap");

  app.mockInput.pressKey("ц");
  await app.flush();
  row = app.ui.diff.content.findDescendantById(`row:${rowId}`);
  expect(app.controller.rowWrap).toBe(false);
  expect(app.controller.store.ui.rowWrap).toBe(false);
  expect(row.height).toBe(1);
});

describe("Tree-sitter packaged assets", () => {
  test("all required grammars load offline and produce syntax spans", async () => {
    const highlighter = await createHighlighter();
    cleanups.push(() => highlighter.destroy());
    const samples = {
      javascript: "const value = 1",
      typescript: "const value: number = 1",
      tsx: "const view = <div>hello</div>",
      json: '{"value": 1}',
      markdown: "# Heading",
      html: "<div>hello</div>",
      css: ".item { color: red; }",
      bash: "if true; then echo ok; fi",
      python: "def value(): return 1",
      kotlin: "fun value(): Int = 1",
      java: "class Value { int value() { return 1; } }",
      go: "package main\nfunc main() {}",
      rust: "fn main() {}",
      yaml: "value: true",
      toml: 'value = "ok"',
    };
    for (const [filetype, source] of Object.entries(samples)) {
      const styled = await highlighter.highlight(source, filetype);
      const result = await highlighter.client.highlightOnce(source, filetype);
      expect(result.error, filetype).toBeUndefined();
      expect(result.highlights?.length ?? 0, filetype).toBeGreaterThan(0);
      expect(styled.chunks.length, filetype).toBeGreaterThan(0);
    }

    const app = await setup(100, 24, highlighter);
    const sourceLine = app.captureSpans().lines.find((line) =>
      line.spans.some((span) => span.text.includes("const")),
    );
    expect(sourceLine).toBeDefined();
    expect(
      new Set(sourceLine.spans.map((span) => JSON.stringify(span.fg))).size,
    ).toBeGreaterThan(1);
  }, 20_000);
});
