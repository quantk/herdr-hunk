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

function focusTab(herdr, tabId) {
  const focused = spawnSync(herdr, ["tab", "focus", tabId], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (focused.status !== 0) {
    throw new Error(describeCommandFailure("herdr tab focus", focused));
  }
}

function renameTab(herdr, tabId) {
  const renamed = spawnSync(herdr, ["tab", "rename", tabId, "Review"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (renamed.status !== 0) {
    throw new Error(describeCommandFailure("herdr tab rename", renamed));
  }
}

function moveReviewToDedicatedTab(herdr, reviewPaneId, workspaceId) {
  const moved = spawnSync(
    herdr,
    [
      "pane",
      "move",
      reviewPaneId,
      "--new-tab",
      "--workspace",
      workspaceId,
      "--label",
      "Review",
      "--focus",
    ],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (moved.status !== 0) {
    throw new Error(describeCommandFailure("herdr pane move", moved));
  }
}

function toggleExistingReview(herdr, review, focusedPaneId) {
  const reviewPane = getPane(herdr, review.reviewPaneId);
  const agentPane = getPane(herdr, review.agentPaneId);
  if (!reviewPane || !agentPane) {
    return false;
  }

  if (reviewPane.tab_id === agentPane.tab_id) {
    const workspaceId = agentPane.workspace_id ?? reviewPane.workspace_id;
    if (!workspaceId) {
      throw new Error("Herdr did not provide the review workspace.");
    }
    moveReviewToDedicatedTab(
      herdr,
      review.reviewPaneId,
      workspaceId,
    );
    process.stdout.write(
      `Moved the existing review for ${review.repo} into its dedicated tab.\n`,
    );
    return true;
  }

  renameTab(herdr, reviewPane.tab_id);
  const focusedPane = focusedPaneId
    ? getPane(herdr, focusedPaneId)
    : undefined;
  if (focusedPane?.tab_id === reviewPane.tab_id) {
    focusTab(herdr, agentPane.tab_id);
    process.stdout.write(
      `Returned to ${review.agentKind ?? "agent"} (${review.agentPaneId}) for ${review.repo}.\n`,
    );
  } else {
    focusTab(herdr, reviewPane.tab_id);
    process.stdout.write(
      `Switched to the review tab for ${review.repo}.\n`,
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
  if (
    focusedReview &&
    toggleExistingReview(herdr, focusedReview, context.focused_pane_id)
  ) {
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
    toggleExistingReview(herdr, activeMatches[0], context.focused_pane_id)
  ) {
    return;
  }

  const agentPane = getPane(herdr, agentPaneId);
  if (!agentPane) {
    throw new Error("The focused agent pane is no longer active.");
  }
  const workspaceId = agentPane.workspace_id ?? context.workspace_id;
  if (!workspaceId) {
    throw new Error("Herdr did not provide the agent workspace.");
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
    "tab",
    "--workspace",
    workspaceId,
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

  const reviewTabId =
    pane.tab_id ?? getPane(herdr, pane.pane_id)?.tab_id;
  if (!reviewTabId) {
    throw new Error("Herdr opened the review but did not return its tab ID.");
  }
  renameTab(herdr, reviewTabId);

  process.stdout.write(
    `Opened a review tab for ${repo} and switched to it.\n`,
  );
}

try {
  main();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
