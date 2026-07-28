import { createCliRenderer } from "@opentui/core";
import { reanchorNotes } from "./review/anchors.mjs";
import { ReviewController } from "./review/controller.mjs";
import { GitSource } from "./review/git-source.mjs";
import { createHighlighter } from "./review/highlighting.mjs";
import { noteMatchesScope, scopeLabel } from "./review/scopes.mjs";
import { shortcutName } from "./review/shortcuts.mjs";
import { readStore, saveStore } from "./review/store.mjs";
import { AgentTurnTracker } from "./review/turn-tracker.mjs";
import { ReviewUI } from "./review/ui.mjs";

const repo = process.env.HERDR_HUNK_REPO;
const reviewKey = process.env.HERDR_HUNK_REVIEW_KEY;
const stateDir = process.env.HERDR_PLUGIN_STATE_DIR;
const agentPaneId = process.env.HERDR_HUNK_AGENT_PANE;
const herdr = process.env.HERDR_BIN_PATH ?? "herdr";

if (!repo || !reviewKey || !stateDir || !agentPaneId) {
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
  renderer?.destroy();
  try {
    await Promise.race([
      highlighter?.destroy(),
      new Promise((resolve) => setTimeout(resolve, 500)),
    ]);
  } catch {
    // Terminal restoration is more important than a parser worker error.
  }
  process.exit(exitCode);
}

function requestShutdown() {
  shutdown(0).catch((error) => {
    process.stderr.write(`Review: cleanup failed: ${error.message}\n`);
    process.exit(1);
  });
}

async function main() {
  const source = new GitSource(repo);
  const tracker = new AgentTurnTracker({
    source,
    herdr,
    agentPaneId,
    reviewKey,
  });
  await tracker.initialize();
  const bootstrapModel = await source.refresh(1);
  let store = readStore(stateDir, reviewKey, repo, { model: bootstrapModel });
  source.setScope(store.ui.scope);
  const initialModel =
    store.ui.scope === "uncommitted"
      ? bootstrapModel
      : await source.refresh(1);
  const notes = store.notes.map((note) =>
    noteMatchesScope(
      note,
      store.ui.scope,
      source.scopeIdentity(),
    )
      ? reanchorNotes([note], initialModel)[0]
      : note
  );
  if (JSON.stringify(notes) !== JSON.stringify(store.notes)) {
    store = saveStore(stateDir, { ...store, notes });
  }

  const controller = new ReviewController({ source, store, stateDir });
  controller.model = initialModel;
  controller.status = initialModel.waiting
    ? "Waiting for the next observed agent turn."
    : `${scopeLabel(controller.scope)}: ${initialModel.files.length} changed file${initialModel.files.length === 1 ? "" : "s"}.`;
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
  renderer.keyInput.on("keypress", (key) => {
    if (
      key.eventType !== "release" &&
      key.ctrl &&
      shortcutName(key) === "c"
    ) {
      key.preventDefault();
      requestShutdown();
    }
  });
  const ui = new ReviewUI(renderer, controller, highlighter);
  await ui.render();
  renderer.start();

  const poll = async () => {
    const previousStatus = controller.status;
    const baselineChanged = await tracker.sample();
    const changed = await controller.refresh();
    if (changed || baselineChanged || controller.status !== previousStatus) {
      await ui.render();
    }
  };
  const schedulePoll = () => {
    if (shuttingDown) return;
    timer = setTimeout(() => {
      poll()
        .then(schedulePoll)
        .catch(async (error) => {
          process.stderr.write(`Review: ${error.message}\n`);
          await shutdown(1);
        });
    }, 1_000);
    timer.unref();
  };
  schedulePoll();
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, requestShutdown);
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
