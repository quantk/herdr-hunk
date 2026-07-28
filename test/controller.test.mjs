import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ReviewController } from "../src/review/controller.mjs";
import { parseUnifiedDiff } from "../src/review/parse-diff.mjs";
import { emptyStore, readStore } from "../src/review/store.mjs";

function model(generation, fingerprint = `f${generation}`) {
  return {
    ...parseUnifiedDiff(
      [
        "diff --git a/a.js b/a.js",
        "--- a/a.js",
        "+++ b/a.js",
        "@@ -1 +1,2 @@",
        "-old",
        "+new",
        "+extra",
      ].join("\n"),
      { generation },
    ),
    fingerprint,
  };
}

test("controller keeps one active refresh, queues only the latest, and persists logical UI state", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "herdr-controller-"));
  let refreshCount = 0;
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const source = {
    status: async () => ({ fingerprint: `f${refreshCount + 1}`, entries: [] }),
    refresh: async (generation) => {
      refreshCount += 1;
      if (refreshCount === 1) await firstGate;
      return model(generation, `f${refreshCount}`);
    },
  };
  const controller = new ReviewController({
    source,
    stateDir,
    store: emptyStore("review-controller", "/repo"),
  });
  controller.model = model(0, "initial");

  const first = controller.refresh({ force: true });
  assert.equal(await controller.refresh({ force: true }), false);
  assert.equal(await controller.refresh({ force: true }), false);
  releaseFirst();
  assert.equal(await first, true);
  await new Promise((resolve) => setImmediate(resolve));
  while (controller.refreshing) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(refreshCount, 2);
  assert.equal(controller.model.generation, 2);

  controller.rowIndex = 1;
  controller.persistUI();
  const stored = readStore(stateDir, "review-controller", "/repo");
  assert.equal(stored.ui.filePath, "a.js");
  assert.equal(stored.ui.rowId, controller.row.id);
});

test("controller finalizes a contiguous same-side range and keeps drafts off disk until save", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "herdr-controller-range-"));
  const controller = new ReviewController({
    source: {},
    stateDir,
    store: emptyStore("review-range", "/repo"),
  });
  controller.model = model(1);
  controller.rowIndex = 1;
  controller.toggleRange();
  controller.moveRow(1);
  controller.toggleRange();
  assert.equal(controller.selectedRows().length, 2);

  controller.beginComment();
  assert.equal(readStore(stateDir, "review-range", "/repo").notes.length, 0);
  controller.cancelEditor();
  assert.equal(readStore(stateDir, "review-range", "/repo").notes.length, 0);

  controller.rowIndex = 1;
  controller.beginComment();
  controller.saveEditor("Saved explicitly.");
  assert.equal(readStore(stateDir, "review-range", "/repo").notes.length, 1);
});

test("controller can anchor an unchanged context line on either side", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "herdr-controller-side-"));
  const contextModel = parseUnifiedDiff(
    [
      "diff --git a/a.js b/a.js",
      "--- a/a.js",
      "+++ b/a.js",
      "@@ -1,2 +1,2 @@",
      " unchanged",
      "-old",
      "+new",
    ].join("\n"),
    { generation: 1 },
  );
  const controller = new ReviewController({
    source: {},
    stateDir,
    store: emptyStore("review-side", "/repo"),
  });
  controller.model = contextModel;
  controller.rowIndex = 0;
  controller.toggleSide();
  controller.beginComment();
  assert.equal(controller.editor.anchor.side, "old");
  controller.cancelEditor();
  controller.toggleSide();
  controller.beginComment();
  assert.equal(controller.editor.anchor.side, "new");
});
