import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import {
  activeReviews,
  buildAgentPrompt,
  describeCommandFailure,
  findHunkSessionIdByLaunch,
  getSnapshotPath,
  loadPromptTemplate,
  parseCommandJson,
  parseContext,
  readState,
  resolveGitRoot,
  selectReview,
  unwrapHunkReviewResponse,
  userNotesFromReview,
} from "./common.mjs";
import { insertPaneDraft } from "./herdr-api.mjs";

function getActiveReviews(herdr, reviews) {
  const listed = spawnSync(herdr, ["pane", "list"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 4 * 1024 * 1024,
  });
  if (listed.status !== 0 || !listed.stdout.trim()) {
    return [];
  }
  const panes =
    parseCommandJson(listed.stdout, "herdr pane list")?.result?.panes;
  const paneIds = new Set(
    Array.isArray(panes) ? panes.map((pane) => pane?.pane_id) : [],
  );
  return activeReviews(reviews, paneIds);
}

function normalizeContextRepo(context) {
  const cwd = context.focused_pane_cwd ?? context.workspace_cwd;
  if (!cwd) {
    return context;
  }
  try {
    const repo = resolveGitRoot(cwd);
    return {
      ...context,
      focused_pane_cwd: repo,
      workspace_cwd: repo,
    };
  } catch {
    return context;
  }
}

function getLiveReview(review) {
  const listed = spawnSync(
    "hunk",
    ["session", "list", "--json"],
    {
      cwd: review.repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5_000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  if (listed.status !== 0 || !listed.stdout.trim()) {
    return undefined;
  }
  const sessionId = findHunkSessionIdByLaunch(
    parseCommandJson(listed.stdout, "hunk session list"),
    review.repo,
    review.openedAt,
  );
  if (!sessionId) {
    return undefined;
  }
  const result = spawnSync(
    "hunk",
    [
      "session",
      "review",
      sessionId,
      "--include-notes",
      "--json",
    ],
    {
      cwd: review.repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5_000,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  if (result.status !== 0 || !result.stdout.trim()) {
    return undefined;
  }
  return unwrapHunkReviewResponse(
    parseCommandJson(result.stdout, "hunk session review"),
  );
}

function getCachedReview(stateDir, reviewKey) {
  try {
    const snapshot = JSON.parse(
      readFileSync(getSnapshotPath(stateDir, reviewKey), "utf8"),
    );
    return unwrapHunkReviewResponse(snapshot.review);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return undefined;
    }
    throw new Error(`Cannot read cached Hunk notes: ${error.message}`);
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

async function main() {
  const stateDir = process.env.HERDR_PLUGIN_STATE_DIR;
  const configDir = process.env.HERDR_PLUGIN_CONFIG_DIR;
  const socketPath = process.env.HERDR_SOCKET_PATH;
  const herdr = process.env.HERDR_BIN_PATH ?? "herdr";
  const context = parseContext(process.env.HERDR_PLUGIN_CONTEXT_JSON);
  const state = readState(stateDir);
  const reviews = getActiveReviews(herdr, state.reviews);
  const review =
    selectReview(reviews, normalizeContextRepo(context)) ??
    (reviews.length === 1 ? reviews[0] : undefined);

  if (!review) {
    throw new Error(
      reviews.length > 1
        ? "Several Hunk reviews are running. Focus the intended Hunk, its agent, or another pane in the same Git repository."
        : "No running Hunk review was found.",
    );
  }

  const reviewModel =
    getLiveReview(review) ??
    getCachedReview(stateDir, review.reviewKey);
  if (!reviewModel) {
    throw new Error(
      "No Hunk snapshot is available yet. Keep the review open for a moment and try again.",
    );
  }

  const notes = userNotesFromReview(reviewModel);
  if (notes.length === 0) {
    throw new Error(
      "This review has no human notes. Add notes in Hunk with `c`, then try again.",
    );
  }

  const prompt = buildAgentPrompt(
    notes,
    review.repo,
    loadPromptTemplate(configDir),
  );
  if (Buffer.byteLength(prompt, "utf8") > 128 * 1024) {
    throw new Error(
      "The review draft is too large to insert as one prompt (limit: 128 KiB).",
    );
  }

  const focused = spawnSync(
    herdr,
    ["agent", "focus", review.agentPaneId],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 2 * 1024 * 1024,
    },
  );
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
    "Hunk draft inserted",
    `${notes.length} note${notes.length === 1 ? "" : "s"} inserted for ${review.agentKind ?? "agent"}; review and send it manually.`,
  );
  process.stdout.write(
    `Inserted ${notes.length} Hunk note${notes.length === 1 ? "" : "s"} into ${review.agentPaneId} without submitting.\n`,
  );
}

try {
  await main();
} catch (error) {
  process.stderr.write(
    `Hunk Review: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
