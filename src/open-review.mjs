import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  PLUGIN_ID,
  describeCommandFailure,
  parseCommandJson,
  parseContext,
  readState,
  reviewsForAgent,
  resolveGitRoot,
  upsertReview,
  writeState,
} from "./common.mjs";

function fail(message) {
  process.stderr.write(`Review: ${message}\n`);
  process.exitCode = 1;
}

function getPane(herdr, paneId) {
  const result = spawnSync(herdr, ["pane", "get", paneId], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0 || !result.stdout.trim()) {
    return undefined;
  }
  return parseCommandJson(result.stdout, "herdr pane get")?.result?.pane;
}

function runPaneMove(herdr, args) {
  const moved = spawnSync(herdr, ["pane", "move", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (moved.status !== 0) {
    throw new Error(describeCommandFailure("herdr pane move", moved));
  }
}

function toggleExistingReview(herdr, review) {
  const reviewPane = getPane(herdr, review.reviewPaneId);
  const agentPane = getPane(herdr, review.agentPaneId);
  if (!reviewPane || !agentPane) {
    return false;
  }

  if (reviewPane.tab_id === agentPane.tab_id) {
    runPaneMove(herdr, [
      review.reviewPaneId,
      "--new-tab",
      "--workspace",
      agentPane.workspace_id,
      "--label",
      "Review",
      "--no-focus",
    ]);
    process.stdout.write(
      `Hid the review for ${review.repo} without closing its session.\n`,
    );
  } else {
    runPaneMove(herdr, [
      review.reviewPaneId,
      "--tab",
      agentPane.tab_id,
      "--split",
      "right",
      "--target-pane",
      review.agentPaneId,
      "--focus",
    ]);
    process.stdout.write(
      `Restored the review for ${review.repo} beside ${review.agentKind ?? "agent"} (${review.agentPaneId}).\n`,
    );
  }
  return true;
}

function main() {
  const context = parseContext(process.env.HERDR_PLUGIN_CONTEXT_JSON);
  const stateDir = process.env.HERDR_PLUGIN_STATE_DIR;
  const herdr = process.env.HERDR_BIN_PATH ?? "herdr";
  const pluginId = process.env.HERDR_PLUGIN_ID ?? PLUGIN_ID;
  const state = readState(stateDir);
  const focusedReview = state.reviews.find(
    (review) => review.reviewPaneId === context.focused_pane_id,
  );
  if (focusedReview && toggleExistingReview(herdr, focusedReview)) {
    return;
  }

  const agentPaneId = context.focused_pane_id;
  if (!agentPaneId || !context.focused_pane_agent) {
    throw new Error(
      "Focus a detected coding agent or its review pane, then run this action again.",
    );
  }

  const cwd = context.focused_pane_cwd ?? context.workspace_cwd;
  const repo = resolveGitRoot(cwd);
  const matchingReviews = reviewsForAgent(
    state.reviews,
    agentPaneId,
    repo,
  );
  const activeMatches = matchingReviews.filter(
    (review) =>
      getPane(herdr, review.reviewPaneId) &&
      getPane(herdr, review.agentPaneId),
  );
  if (activeMatches.length > 1) {
    throw new Error(
      "Several active reviews are associated with this agent and repository. Close the obsolete pane before opening another.",
    );
  }
  if (
    activeMatches.length === 1 &&
    toggleExistingReview(herdr, activeMatches[0])
  ) {
    return;
  }

  const reviewKey =
    matchingReviews.length === 1
      ? matchingReviews[0].reviewKey
      : randomUUID();
  const args = [
    "plugin",
    "pane",
    "open",
    "--plugin",
    pluginId,
    "--entrypoint",
    "review",
    "--placement",
    "split",
    "--target-pane",
    agentPaneId,
    "--direction",
    "right",
    "--env",
    `HERDR_HUNK_REVIEW_KEY=${reviewKey}`,
    "--env",
    `HERDR_HUNK_REPO=${repo}`,
    "--env",
    `HERDR_HUNK_AGENT_PANE=${agentPaneId}`,
    "--focus",
  ];
  const opened = spawnSync(herdr, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (opened.status !== 0) {
    throw new Error(describeCommandFailure("herdr plugin pane open", opened));
  }

  const response = parseCommandJson(opened.stdout, "herdr plugin pane open");
  const pane = response?.result?.plugin_pane?.pane;
  if (!pane?.pane_id) {
    throw new Error("Herdr opened the review but did not return its pane ID.");
  }

  writeState(
    stateDir,
    upsertReview(state, {
      reviewKey,
      repo,
      agentPaneId,
      agentKind: context.focused_pane_agent,
      reviewPaneId: pane.pane_id,
      workspaceId: pane.workspace_id ?? context.workspace_id,
      openedAt: new Date().toISOString(),
    }),
  );

  process.stdout.write(
    `Opened a review for ${repo} beside ${context.focused_pane_agent} (${agentPaneId}).\n`,
  );
}

try {
  main();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
