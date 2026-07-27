import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export const PLUGIN_ID = "quantick.hunk-review";
export const STATE_FILE = "reviews.json";
export const RESTORED_USER_AUTHOR = "user (restored)";
export const PROMPT_TEMPLATE_FILE = "prompt-template.md";
export const DEFAULT_PROMPT_TEMPLATE = `I finished reviewing your changes in Hunk.
Repository: {{repository}}

Address all review notes below. Verify each note against the current code first. If a note is outdated or conflicts with the task, explain why instead of changing the code blindly.

{{notes}}

After addressing the notes, run the relevant checks and briefly summarize what changed for each note.`;

export function parseContext(raw) {
  if (!raw) {
    return {};
  }

  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : {};
  } catch {
    throw new Error("Herdr provided invalid HERDR_PLUGIN_CONTEXT_JSON.");
  }
}

export function getStatePath(stateDir) {
  if (!stateDir) {
    throw new Error("HERDR_PLUGIN_STATE_DIR is not set.");
  }
  return join(stateDir, STATE_FILE);
}

export function getSnapshotPath(stateDir, reviewKey) {
  if (!stateDir) {
    throw new Error("HERDR_PLUGIN_STATE_DIR is not set.");
  }
  if (!reviewKey || !/^[a-zA-Z0-9-]+$/.test(reviewKey)) {
    throw new Error("Invalid Hunk review key.");
  }
  return join(stateDir, "snapshots", `${reviewKey}.json`);
}

export function readState(stateDir) {
  try {
    const parsed = JSON.parse(readFileSync(getStatePath(stateDir), "utf8"));
    return {
      version: 1,
      reviews: Array.isArray(parsed.reviews) ? parsed.reviews : [],
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { version: 1, reviews: [] };
    }
    throw new Error(`Cannot read plugin state: ${error.message}`);
  }
}

export function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temporaryPath, path);
}

export function writeState(stateDir, state) {
  writeJsonAtomic(getStatePath(stateDir), {
    version: 1,
    reviews: state.reviews,
  });
}

export function upsertReview(state, review) {
  const reviews = state.reviews.filter(
    (item) =>
      item.reviewKey !== review.reviewKey &&
      item.reviewPaneId !== review.reviewPaneId,
  );
  reviews.push(review);
  reviews.sort((left, right) =>
    String(left.openedAt).localeCompare(String(right.openedAt)),
  );
  return { version: 1, reviews: reviews.slice(-50) };
}

export function selectReview(reviews, context) {
  if (!Array.isArray(reviews) || reviews.length === 0) {
    return undefined;
  }

  const focusedPaneId = context.focused_pane_id;
  const workspaceId = context.workspace_id;
  const cwd = context.focused_pane_cwd ?? context.workspace_cwd;
  const newestFirst = [...reviews].sort((left, right) =>
    String(right.openedAt).localeCompare(String(left.openedAt)),
  );

  return (
    newestFirst.find(
      (item) =>
        focusedPaneId &&
        (item.reviewPaneId === focusedPaneId ||
          item.agentPaneId === focusedPaneId),
    ) ??
    newestFirst.find(
      (item) =>
        workspaceId &&
        item.workspaceId === workspaceId &&
        (!cwd || item.repo === cwd),
    ) ??
    newestFirst.find(
      (item) => workspaceId && item.workspaceId === workspaceId,
    ) ??
    newestFirst.find((item) => cwd && item.repo === cwd)
  );
}

export function reviewsForAgent(reviews, agentPaneId, repo) {
  if (!Array.isArray(reviews) || !agentPaneId || !repo) {
    return [];
  }
  return reviews
    .filter(
      (review) =>
        review?.agentPaneId === agentPaneId &&
        review?.repo === repo &&
        review?.reviewPaneId,
    )
    .sort((left, right) =>
      String(right.openedAt).localeCompare(String(left.openedAt)),
    );
}

export function activeReviews(reviews, paneIds) {
  if (!Array.isArray(reviews) || !(paneIds instanceof Set)) {
    return [];
  }
  return reviews.filter((review) => paneIds.has(review?.reviewPaneId));
}

export function resolveGitRoot(cwd, run = execFileSync) {
  if (!cwd) {
    throw new Error("Herdr did not provide a working directory.");
  }

  try {
    return run("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    throw new Error(`The focused agent is not running in a Git repository: ${cwd}`);
  }
}

export function parseCommandJson(stdout, commandName) {
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`${commandName} returned invalid JSON.`);
  }
}

export function unwrapHunkReviewResponse(response) {
  const review = response?.review ?? response;
  if (!review || typeof review !== "object" || Array.isArray(review)) {
    throw new Error("Hunk returned an invalid review model.");
  }
  return review;
}

export function findHunkSessionId(response, pid, repo) {
  const sessions = response?.sessions ?? response?.result?.sessions;
  if (!Array.isArray(sessions) || !Number.isInteger(pid)) {
    return undefined;
  }
  return sessions.find(
    (session) =>
      session?.pid === pid &&
      (!repo || session?.repoRoot === repo),
  )?.sessionId;
}

export function findHunkSessionIdByLaunch(
  response,
  repo,
  openedAt,
  toleranceMs = 10_000,
) {
  const sessions = response?.sessions ?? response?.result?.sessions;
  const openedTime = Date.parse(openedAt);
  if (!Array.isArray(sessions) || !Number.isFinite(openedTime)) {
    return undefined;
  }

  return sessions
    .filter(
      (session) =>
        session?.repoRoot === repo &&
        typeof session?.sessionId === "string" &&
        Number.isFinite(Date.parse(session?.launchedAt)),
    )
    .map((session) => ({
      sessionId: session.sessionId,
      distance: Math.abs(Date.parse(session.launchedAt) - openedTime),
    }))
    .filter((session) => session.distance <= toleranceMs)
    .sort((left, right) => left.distance - right.distance)[0]?.sessionId;
}

export function userNotesFromReview(review) {
  if (!review || !Array.isArray(review.reviewNotes)) {
    return [];
  }
  return review.reviewNotes.filter(
    (note) =>
      (note?.source === "user" ||
        (note?.source === "agent" &&
          note?.author === RESTORED_USER_AUTHOR)) &&
      typeof note.body === "string",
  );
}

export function restoreCommentsFromReview(review) {
  return userNotesFromReview(review).flatMap((note) => {
    const comment = {
      filePath: note.filePath,
      summary: note.body,
      author: RESTORED_USER_AUTHOR,
    };
    if (Array.isArray(note.newRange) && Number.isInteger(note.newRange[0])) {
      return [{ ...comment, newLine: note.newRange[0] }];
    }
    if (Array.isArray(note.oldRange) && Number.isInteger(note.oldRange[0])) {
      return [{ ...comment, oldLine: note.oldRange[0] }];
    }
    if (Number.isInteger(note.hunkIndex)) {
      return [{ ...comment, hunk: note.hunkIndex + 1 }];
    }
    return [];
  });
}

function formatRange(range) {
  if (!Array.isArray(range) || range.length !== 2) {
    return undefined;
  }
  const [start, end] = range;
  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    return undefined;
  }
  return end > start ? `${start}-${end}` : String(start);
}

export function formatNoteLocation(note) {
  const parts = [note.filePath || "(unknown file)"];
  const newRange = formatRange(note.newRange);
  const oldRange = formatRange(note.oldRange);

  if (newRange) {
    parts.push(`new lines ${newRange}`);
  } else if (oldRange) {
    parts.push(`old lines ${oldRange}`);
  } else if (Number.isInteger(note.hunkIndex)) {
    parts.push(`hunk ${note.hunkIndex + 1}`);
  }
  return parts.join(", ");
}

export function loadPromptTemplate(configDir) {
  if (!configDir) {
    return DEFAULT_PROMPT_TEMPLATE;
  }

  const path = join(configDir, PROMPT_TEMPLATE_FILE);
  try {
    const template = readFileSync(path, "utf8").trim();
    if (!template) {
      throw new Error(`${PROMPT_TEMPLATE_FILE} is empty.`);
    }
    return template;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return DEFAULT_PROMPT_TEMPLATE;
    }
    if (
      error instanceof Error &&
      error.message === `${PROMPT_TEMPLATE_FILE} is empty.`
    ) {
      throw error;
    }
    throw new Error(`Cannot read ${PROMPT_TEMPLATE_FILE}: ${error.message}`);
  }
}

export function buildAgentPrompt(
  notes,
  repo,
  template = DEFAULT_PROMPT_TEMPLATE,
) {
  const renderedNotes = notes.map((note, index) => {
    const title = note.title ? ` — ${note.title}` : "";
    return [
      `### ${index + 1}. ${formatNoteLocation(note)}${title}`,
      note.body.trim(),
    ].join("\n");
  }).join("\n\n");

  if (!template.includes("{{notes}}")) {
    throw new Error(
      `${PROMPT_TEMPLATE_FILE} must contain the {{notes}} placeholder.`,
    );
  }

  const supportedPlaceholders = new Set([
    "repository",
    "notes",
    "note_count",
  ]);
  const unknownPlaceholders = [
    ...new Set(
      [...template.matchAll(/\{\{([^{}]+)\}\}/g)]
        .map((match) => match[1])
        .filter((name) => !supportedPlaceholders.has(name)),
    ),
  ];
  if (unknownPlaceholders.length > 0) {
    throw new Error(
      `${PROMPT_TEMPLATE_FILE} contains unknown placeholder${unknownPlaceholders.length === 1 ? "" : "s"}: ${unknownPlaceholders.map((name) => `{{${name}}}`).join(", ")}.`,
    );
  }

  const replacements = {
    repository: repo,
    notes: renderedNotes,
    note_count: String(notes.length),
  };
  return Object.entries(replacements).reduce(
    (prompt, [name, value]) =>
      prompt.replaceAll(`{{${name}}}`, value),
    template,
  );
}

export function describeCommandFailure(command, result) {
  const detail =
    result?.stderr?.trim() ||
    result?.stdout?.trim() ||
    result?.error?.message ||
    `exit code ${result?.status ?? "unknown"}`;
  return `${command} failed: ${detail}`;
}
