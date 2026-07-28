import { spawnSync } from "node:child_process";
import {
  activeReviews,
  buildAgentPrompt,
  describeCommandFailure,
  loadPromptTemplate,
  parseCommandJson,
  parseContext,
  readState,
  resolveGitRoot,
  selectReview,
} from "./common.mjs";
import { insertPaneDraft } from "./herdr-api.mjs";
import { noteMatchesScope, scopeLabel } from "./review/scopes.mjs";
import { readStore } from "./review/store.mjs";

function getActiveReviews(herdr, reviews) {
  const listed = spawnSync(herdr, ["pane", "list"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 4 * 1024 * 1024,
  });
  if (listed.status !== 0 || !listed.stdout.trim()) return [];
  const panes = parseCommandJson(listed.stdout, "herdr pane list")?.result?.panes;
  const paneIds = new Set(
    Array.isArray(panes) ? panes.map((pane) => pane?.pane_id) : [],
  );
  return activeReviews(reviews, paneIds);
}

function normalizeContextRepo(context) {
  const cwd = context.focused_pane_cwd ?? context.workspace_cwd;
  if (!cwd) return context;
  try {
    const repo = resolveGitRoot(cwd);
    return { ...context, focused_pane_cwd: repo, workspace_cwd: repo };
  } catch {
    return context;
  }
}

function notify(herdr, title, body) {
  spawnSync(
    herdr,
    [
      "notification",
      "show",
      title,
      "--body",
      body,
      "--position",
      "top-right",
      "--sound",
      "done",
    ],
    { encoding: "utf8", stdio: "ignore" },
  );
}

function activeScopeBase(store, review) {
  if (store.ui.scope !== "last-turn") return store.ui.scopeBase;
  const resolved = spawnSync(
    "git",
    [
      "-C",
      review.repo,
      "rev-parse",
      "--verify",
      `refs/herdr-hunk/turn-base/${review.reviewKey}^{tree}`,
    ],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  return resolved.status === 0 ? resolved.stdout.trim() : null;
}

async function main() {
  const stateDir = process.env.HERDR_PLUGIN_STATE_DIR;
  const configDir = process.env.HERDR_PLUGIN_CONFIG_DIR;
  const socketPath = process.env.HERDR_SOCKET_PATH;
  const herdr = process.env.HERDR_BIN_PATH ?? "herdr";
  const context = parseContext(process.env.HERDR_PLUGIN_CONTEXT_JSON);
  const reviews = getActiveReviews(herdr, readState(stateDir).reviews);
  const review = selectReview(reviews, normalizeContextRepo(context));
  if (!review) throw new Error("No running review was found.");

  const store = readStore(stateDir, review.reviewKey, review.repo);
  const scope = store.ui.scope;
  const scopeBase = activeScopeBase(store, review);
  const notes = store.notes.filter(
    (note) =>
      note.provenance === "human" &&
      note.resolvedAt == null &&
      noteMatchesScope(note, scope, scopeBase),
  );
  if (notes.length === 0) {
    throw new Error(
      `The active ${scopeLabel(scope)} review has no open saved human notes. Add, reopen, or save a comment, then try again.`,
    );
  }
  const prompt = buildAgentPrompt(
    notes,
    review.repo,
    loadPromptTemplate(configDir),
  );
  if (Buffer.byteLength(prompt, "utf8") > 128 * 1024) {
    throw new Error("The review draft is too large to insert as one prompt (limit: 128 KiB).");
  }

  const focused = spawnSync(herdr, ["agent", "focus", review.agentPaneId], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 2 * 1024 * 1024,
  });
  if (focused.status !== 0) {
    throw new Error(describeCommandFailure("herdr agent focus", focused));
  }
  try {
    await insertPaneDraft(socketPath, review.agentPaneId, prompt);
  } catch (error) {
    throw new Error(`Cannot insert the agent draft: ${error.message}`);
  }

  notify(
    herdr,
    "Review draft inserted",
    `${notes.length} note${notes.length === 1 ? "" : "s"} inserted for ${review.agentKind ?? "agent"}; review and send it manually.`,
  );
  process.stdout.write(
    `Inserted ${notes.length} review note${notes.length === 1 ? "" : "s"} into ${review.agentPaneId} without submitting.\n`,
  );
}

try {
  await main();
} catch (error) {
  process.stderr.write(
    `Review: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
