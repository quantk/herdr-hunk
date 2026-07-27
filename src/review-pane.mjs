import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  findHunkSessionId,
  getSnapshotPath,
  parseCommandJson,
  restoreCommentsFromReview,
  unwrapHunkReviewResponse,
  writeJsonAtomic,
} from "./common.mjs";

const repo = process.env.HERDR_HUNK_REPO;
const reviewKey = process.env.HERDR_HUNK_REVIEW_KEY;
const stateDir = process.env.HERDR_PLUGIN_STATE_DIR;

if (!repo || !reviewKey || !stateDir) {
  process.stderr.write(
    "Hunk Review: missing launch context. Open this pane through the “Review changes with Hunk” action.\n",
  );
  process.exit(1);
}

const hunkCheck = spawnSync("hunk", ["--version"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});
if (hunkCheck.status !== 0) {
  process.stderr.write(
    "Hunk Review: `hunk` is not available on PATH. Install it with `npm i -g hunkdiff`.\n",
  );
  process.exit(1);
}

const snapshotPath = getSnapshotPath(stateDir, reviewKey);
let snapshotInProgress = false;
let hunkSessionId;
let restoreComplete = false;

function readRestoreComments() {
  try {
    const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
    return restoreCommentsFromReview(
      unwrapHunkReviewResponse(snapshot.review),
    );
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    return [];
  }
}

const restoreComments = readRestoreComments();
restoreComplete = restoreComments.length === 0;

function resolveHunkSessionId() {
  if (hunkSessionId) {
    return hunkSessionId;
  }
  const result = spawnSync("hunk", ["session", "list", "--json"], {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 4_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.status !== 0 || !result.stdout.trim()) {
    return undefined;
  }
  hunkSessionId = findHunkSessionId(
    parseCommandJson(result.stdout, "hunk session list"),
    hunk.pid,
    repo,
  );
  return hunkSessionId;
}

function restoreCachedComments(sessionId) {
  const result = spawnSync(
    "hunk",
    [
      "session",
      "comment",
      "apply",
      sessionId,
      "--stdin",
      "--focus",
      "--json",
    ],
    {
      cwd: repo,
      encoding: "utf8",
      input: JSON.stringify({ comments: restoreComments }),
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 4_000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  return result.status === 0;
}

function captureSnapshot() {
  if (snapshotInProgress) {
    return;
  }
  snapshotInProgress = true;
  try {
    const sessionId = resolveHunkSessionId();
    if (!sessionId) {
      return;
    }
    if (!restoreComplete) {
      if (!restoreCachedComments(sessionId)) {
        return;
      }
      restoreComplete = true;
      return;
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
        cwd: repo,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 4_000,
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    if (result.status === 0 && result.stdout.trim()) {
      const review = unwrapHunkReviewResponse(
        parseCommandJson(result.stdout, "hunk session review"),
      );
      writeJsonAtomic(snapshotPath, {
        capturedAt: new Date().toISOString(),
        review,
      });
    }
  } catch {
    // The session may not be registered yet, or may already be closing.
  } finally {
    snapshotInProgress = false;
  }
}

const hunk = spawn("hunk", ["diff", "--watch"], {
  cwd: repo,
  env: process.env,
  stdio: "inherit",
});

const timer = setInterval(captureSnapshot, 1_000);
timer.unref();
setTimeout(captureSnapshot, 350).unref();

function forwardSignal(signal) {
  captureSnapshot();
  if (!hunk.killed) {
    hunk.kill(signal);
  }
}

process.on("SIGINT", () => forwardSignal("SIGINT"));
process.on("SIGTERM", () => forwardSignal("SIGTERM"));

hunk.on("error", (error) => {
  clearInterval(timer);
  process.stderr.write(`Hunk Review: cannot start Hunk: ${error.message}\n`);
  process.exitCode = 1;
});

hunk.on("exit", (code, signal) => {
  clearInterval(timer);
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
