import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestRenderer } from "@opentui/core/testing";
import { ReviewController } from "../src/review/controller.mjs";
import { createHighlighter } from "../src/review/highlighting.mjs";
import { parseUnifiedDiff } from "../src/review/parse-diff.mjs";
import { emptyStore } from "../src/review/store.mjs";
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

async function setup(width = 100, height = 24, highlighterOverride) {
  const testRenderer = await createTestRenderer({ width, height });
  const stateDir = mkdtempSync(join(tmpdir(), "herdr-ui-"));
  const source = {
    status: async () => ({ fingerprint: "next", entries: [] }),
    refresh: async () => testModel(),
  };
  const controller = new ReviewController({
    source,
    stateDir,
    store: emptyStore("review-ui", "/repo"),
  });
  controller.model = testModel();
  controller.status = "Ready.";
  const highlighter =
    highlighterOverride ?? { highlight: async (value) => value };
  const ui = new ReviewUI(testRenderer.renderer, controller, highlighter);
  await ui.render();
  await testRenderer.flush();
  cleanups.push(async () => testRenderer.renderer.destroy());
  return { ...testRenderer, controller, ui };
}

test("keyboard navigation, multiline paste, save, cancel, and resize preserve state", async () => {
  const app = await setup();
  expect(app.captureCharFrame()).toContain("unified diff");

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
  expect(app.captureCharFrame()).toContain("saved comment");
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
