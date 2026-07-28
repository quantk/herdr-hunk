import { createCliRenderer } from "@opentui/core";
import { reanchorNotes } from "./review/anchors.mjs";
import { ReviewController } from "./review/controller.mjs";
import { GitSource } from "./review/git-source.mjs";
import { createHighlighter } from "./review/highlighting.mjs";
import { readStore, saveStore } from "./review/store.mjs";
import { ReviewUI } from "./review/ui.mjs";

const repo = process.env.HERDR_HUNK_REPO;
const reviewKey = process.env.HERDR_HUNK_REVIEW_KEY;
const stateDir = process.env.HERDR_PLUGIN_STATE_DIR;

if (!repo || !reviewKey || !stateDir) {
  process.stderr.write(
    "Review: missing launch context. Open this pane through the “Review changes” action.\n",
  );
  process.exit(1);
}

let renderer;
let highlighter;
let timer;
let shuttingDown = false;

async function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (timer) clearInterval(timer);
  try {
    await highlighter?.destroy();
  } catch {
    // Terminal restoration is more important than a parser worker error.
  }
  renderer?.destroy();
  process.exitCode = exitCode;
}

async function main() {
  const source = new GitSource(repo);
  const initialModel = await source.refresh(1);
  let store = readStore(stateDir, reviewKey, repo, { model: initialModel });
  const notes = reanchorNotes(store.notes, initialModel);
  if (JSON.stringify(notes) !== JSON.stringify(store.notes)) {
    store = saveStore(stateDir, { ...store, notes });
  }

  const controller = new ReviewController({ source, store, stateDir });
  controller.model = initialModel;
  controller.status = `${initialModel.files.length} changed file${initialModel.files.length === 1 ? "" : "s"}.`;
  const storedFile = initialModel.files.findIndex(
    (file) => file.path === store.ui?.filePath,
  );
  if (storedFile >= 0) {
    controller.fileIndex = storedFile;
    const storedRow = controller.file.rows.findIndex(
      (row) => row.id === store.ui?.rowId,
    );
    if (storedRow >= 0) controller.rowIndex = storedRow;
  }

  highlighter = await createHighlighter();
  renderer = await createCliRenderer({
    exitOnCtrlC: false,
    clearOnShutdown: true,
    useMouse: true,
    enableMouseMovement: true,
    screenMode: "alternate-screen",
  });
  const ui = new ReviewUI(renderer, controller, highlighter);
  await ui.render();
  renderer.start();

  timer = setInterval(async () => {
    const changed = await controller.refresh();
    if (changed) await ui.render();
  }, 1_000);
  timer.unref();
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    shutdown(0).catch((error) => {
      process.stderr.write(`Review: cleanup failed: ${error.message}\n`);
      process.exitCode = 1;
    });
  });
}

process.on("uncaughtException", async (error) => {
  process.stderr.write(`Review: ${error.message}\n`);
  await shutdown(1);
});
process.on("unhandledRejection", async (error) => {
  process.stderr.write(`Review: ${error instanceof Error ? error.message : String(error)}\n`);
  await shutdown(1);
});

try {
  await main();
} catch (error) {
  process.stderr.write(
    `Review: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  await shutdown(1);
}
