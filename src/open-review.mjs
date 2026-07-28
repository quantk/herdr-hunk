import { randomUUID } from "node:crypto";
import {
  PLUGIN_ID,
  compactReviews,
  describeCommandFailure,
  parseCommandJson,
  parseContext,
  readState,
  reviewsForAgent,
  resolveGitRoot,
  upsertReview,
  withStateLock,
  writeState,
} from "./common.mjs";
import {
  getHerdrPane,
  listHerdrPanes,
  runHerdr,
} from "./herdr-cli.mjs";

function fail(message) {
  process.stderr.write(`Review: ${message}\n`);
  process.exitCode = 1;
}

function focusTab(herdr, tabId) {
  const focused = runHerdr(herdr, ["tab", "focus", tabId]);
  if (focused.status !== 0) {
    throw new Error(describeCommandFailure("herdr tab focus", focused));
  }
}

function renameTab(herdr, tabId) {
  const renamed = runHerdr(herdr, ["tab", "rename", tabId, "Review"]);
  if (renamed.status !== 0) {
    throw new Error(describeCommandFailure("herdr tab rename", renamed));
  }
}

function moveReviewToDedicatedTab(herdr, reviewPaneId, workspaceId) {
  const moved = runHerdr(
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
  );
  if (moved.status !== 0) {
    throw new Error(describeCommandFailure("herdr pane move", moved));
  }
}

function toggleExistingReview(herdr, review, focusedPaneId) {
  const reviewPane = getHerdrPane(herdr, review.reviewPaneId);
  const agentPane = getHerdrPane(herdr, review.agentPaneId);
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
    ? getHerdrPane(herdr, focusedPaneId)
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
  const panes = listHerdrPanes(herdr);
  const paneIds = new Set(panes.map((pane) => pane?.pane_id).filter(Boolean));
  const storedState = readState(stateDir);
  const state = {
    version: 1,
    reviews: compactReviews(storedState.reviews, paneIds),
  };
  if (state.reviews.length !== storedState.reviews.length) {
    writeState(stateDir, state);
  }
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
      getHerdrPane(herdr, review.reviewPaneId) &&
      getHerdrPane(herdr, review.agentPaneId),
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

  const agentPane = getHerdrPane(herdr, agentPaneId);
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
  const opened = runHerdr(herdr, args);
  if (opened.status !== 0) {
    throw new Error(describeCommandFailure("herdr plugin pane open", opened));
  }

  const response = parseCommandJson(opened.stdout, "herdr plugin pane open");
  const pane = response?.result?.plugin_pane?.pane;
  if (!pane?.pane_id) {
    throw new Error("Herdr opened the review but did not return its pane ID.");
  }

  try {
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
  } catch (error) {
    const closed = runHerdr(
      herdr,
      ["plugin", "pane", "close", pane.pane_id],
    );
    const cleanup =
      closed.status === 0
        ? ""
        : ` Cleanup also failed: ${describeCommandFailure("herdr plugin pane close", closed)}`;
    throw new Error(`${error.message}.${cleanup}`);
  }

  try {
    const reviewTabId =
      pane.tab_id ?? getHerdrPane(herdr, pane.pane_id)?.tab_id;
    if (!reviewTabId) {
      throw new Error("Herdr did not return the review tab ID.");
    }
    renameTab(herdr, reviewTabId);
  } catch (error) {
    process.stderr.write(
      `Review: opened successfully, but the tab could not be renamed: ${error.message}\n`,
    );
  }

  process.stdout.write(
    `Opened a review tab for ${repo} and switched to it.\n`,
  );
}

try {
  withStateLock(process.env.HERDR_PLUGIN_STATE_DIR, main);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
