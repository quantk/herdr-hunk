import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

export const PLUGIN_ID = "quantick.hunk-review";
export const STATE_FILE = "reviews.json";
export const STATE_LOCK_FILE = "reviews.lock";
export const RESTORED_USER_AUTHOR = "user (restored)";
export const PROMPT_TEMPLATE_FILE = "prompt-template.md";
export const DEFAULT_PROMPT_TEMPLATE = `I finished reviewing your changes.
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
    throw new Error("Invalid review key.");
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
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(temporaryPath, path);
  } finally {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
  }
}

export function writeState(stateDir, state) {
  writeJsonAtomic(getStatePath(stateDir), {
    version: 1,
    reviews: state.reviews,
  });
}

function removeStaleStateLock(path) {
  let ownerPid;
  try {
    ownerPid = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
  } catch {
    return false;
  }
  if (!Number.isInteger(ownerPid) || ownerPid <= 0) {
    return false;
  }
  try {
    process.kill(ownerPid, 0);
    return false;
  } catch (error) {
    if (error?.code !== "ESRCH") return false;
  }
  try {
    unlinkSync(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    return false;
  }
}

export function withStateLock(stateDir, callback) {
  if (!stateDir) {
    throw new Error("HERDR_PLUGIN_STATE_DIR is not set.");
  }
  mkdirSync(stateDir, { recursive: true });
  const path = join(stateDir, STATE_LOCK_FILE);
  let descriptor;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      descriptor = openSync(path, "wx", 0o600);
      break;
    } catch (error) {
      if (
        error?.code === "EEXIST" &&
        attempt === 0 &&
        removeStaleStateLock(path)
      ) {
        continue;
      }
      if (error?.code === "EEXIST") {
        throw new Error(
          "Another review action is already running. Try again in a moment.",
        );
      }
      throw new Error(`Cannot lock plugin state: ${error.message}`);
    }
  }
  try {
    writeFileSync(descriptor, `${process.pid}\n`, "utf8");
  } catch (error) {
    closeSync(descriptor);
    descriptor = undefined;
    try {
      unlinkSync(path);
    } catch {
      // Preserve the original lock-write error.
    }
    throw new Error(`Cannot initialize plugin state lock: ${error.message}`);
  }

  let result;
  let callbackError;
  try {
    result = callback();
  } catch (error) {
    callbackError = error;
  }

  let cleanupError;
  try {
    if (descriptor != null) closeSync(descriptor);
  } catch (error) {
    cleanupError = error;
  }
  try {
    unlinkSync(path);
  } catch (error) {
    if (error?.code !== "ENOENT" && cleanupError == null) {
      cleanupError = error;
    }
  }

  if (callbackError != null) {
    throw callbackError;
  }
  if (cleanupError != null) {
    throw new Error(`Cannot unlock plugin state: ${cleanupError.message}`);
  }
  return result;
}

export function upsertReview(state, review) {
  const reviews = state.reviews.filter(
    (item) =>
      item.reviewKey !== review.reviewKey &&
      item.reviewPaneId !== review.reviewPaneId &&
      !(
        item.agentPaneId === review.agentPaneId &&
        item.repo === review.repo
      ),
  );
  reviews.push(review);
  reviews.sort((left, right) =>
    String(left.openedAt).localeCompare(String(right.openedAt)),
  );
  return { version: 1, reviews };
}

export function compactReviews(reviews, paneIds) {
  if (!Array.isArray(reviews) || !(paneIds instanceof Set)) {
    return [];
  }
  return reviews.filter(
    (review) =>
      paneIds.has(review?.agentPaneId) ||
      paneIds.has(review?.reviewPaneId),
  );
}

export function selectReview(reviews, context) {
  if (!Array.isArray(reviews) || reviews.length === 0) {
    return undefined;
  }

  const focusedPaneId = context.focused_pane_id;
  const workspaceId = context.workspace_id;
  const cwd = context.focused_pane_cwd ?? context.workspace_cwd;
  const unique = (candidates, description) => {
    if (candidates.length > 1) {
      throw new Error(
        `Several active reviews match ${description}. Focus the intended review pane or source agent.`,
      );
    }
    return candidates[0];
  };
  const focusedReview = reviews.filter(
    (item) => focusedPaneId && item.reviewPaneId === focusedPaneId,
  );
  if (focusedReview.length) return unique(focusedReview, "the focused review pane");
  const focusedAgent = reviews.filter(
    (item) => focusedPaneId && item.agentPaneId === focusedPaneId,
  );
  if (focusedAgent.length) return unique(focusedAgent, "the focused source agent");
  const workspaceRepo = reviews.filter(
    (item) =>
      workspaceId &&
      cwd &&
      item.workspaceId === workspaceId &&
      item.repo === cwd,
  );
  if (workspaceRepo.length) {
    return unique(workspaceRepo, "this workspace and repository");
  }
  const repository = reviews.filter((item) => cwd && item.repo === cwd);
  if (repository.length) return unique(repository, "this repository");
  return unique(reviews, "the current context");
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
  return reviews.filter(
    (review) =>
      paneIds.has(review?.reviewPaneId) &&
      paneIds.has(review?.agentPaneId),
  );
}

export function resolveGitRoot(cwd, run = execFileSync) {
  if (!cwd) {
    throw new Error("Herdr did not provide a working directory.");
  }

  try {
    return run("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
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
  if (note?.anchor) {
    const { anchor } = note;
    const range =
      anchor.endLine > anchor.startLine
        ? `${anchor.startLine}-${anchor.endLine}`
        : String(anchor.startLine);
    return `${anchor.path}, ${anchor.side} lines ${range}${note.status === "stale" ? " (STALE LOCATION; original context)" : ""}`;
  }
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
    const context = [];
    if (note.anchor?.contextBefore?.length) {
      context.push("", "Context before:", "```", ...note.anchor.contextBefore, "```");
    }
    if (note.anchor?.selectedText?.length) {
      context.push(
        "",
        note.status === "stale"
          ? "Original selected context (location is stale):"
          : "Selected context:",
        "```",
        ...note.anchor.selectedText,
        "```",
      );
    }
    if (note.anchor?.contextAfter?.length) {
      context.push("", "Context after:", "```", ...note.anchor.contextAfter, "```");
    }
    return [
      `### ${index + 1}. ${formatNoteLocation(note)}${title}`,
      note.body.trim(),
      ...context,
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
