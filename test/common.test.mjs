import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  activeReviews,
  buildAgentPrompt,
  findHunkSessionId,
  findHunkSessionIdByLaunch,
  formatNoteLocation,
  getSnapshotPath,
  parseContext,
  readState,
  restoreCommentsFromReview,
  reviewsForAgent,
  selectReview,
  upsertReview,
  unwrapHunkReviewResponse,
  userNotesFromReview,
  writeJsonAtomic,
  writeState,
} from "../src/common.mjs";

test("parseContext accepts an object and rejects malformed JSON", () => {
  assert.deepEqual(parseContext('{"focused_pane_id":"w1:p1"}'), {
    focused_pane_id: "w1:p1",
  });
  assert.deepEqual(parseContext(""), {});
  assert.throws(() => parseContext("{"), /invalid HERDR_PLUGIN_CONTEXT_JSON/);
});

test("selectReview prioritizes an exact pane match", () => {
  const reviews = [
    {
      reviewKey: "older",
      reviewPaneId: "w1:p2",
      agentPaneId: "w1:p1",
      workspaceId: "w1",
      repo: "/repo",
      openedAt: "2026-01-01T00:00:00.000Z",
    },
    {
      reviewKey: "newer",
      reviewPaneId: "w1:p4",
      agentPaneId: "w1:p3",
      workspaceId: "w1",
      repo: "/repo",
      openedAt: "2026-01-02T00:00:00.000Z",
    },
  ];

  assert.equal(
    selectReview(reviews, {
      focused_pane_id: "w1:p1",
      workspace_id: "w1",
    }).reviewKey,
    "older",
  );
  assert.equal(
    selectReview(reviews, { workspace_id: "w1" }).reviewKey,
    "newer",
  );
});

test("reviewsForAgent returns matching reviews newest first", () => {
  const reviews = [
    {
      reviewKey: "older",
      reviewPaneId: "w1:p2",
      agentPaneId: "w1:p1",
      repo: "/repo",
      openedAt: "2026-01-01T00:00:00.000Z",
    },
    {
      reviewKey: "other-agent",
      reviewPaneId: "w1:p4",
      agentPaneId: "w1:p3",
      repo: "/repo",
      openedAt: "2026-01-03T00:00:00.000Z",
    },
    {
      reviewKey: "newer",
      reviewPaneId: "w1:p5",
      agentPaneId: "w1:p1",
      repo: "/repo",
      openedAt: "2026-01-02T00:00:00.000Z",
    },
  ];

  assert.deepEqual(
    reviewsForAgent(reviews, "w1:p1", "/repo").map(
      (review) => review.reviewKey,
    ),
    ["newer", "older"],
  );
});

test("activeReviews excludes stale review pane records", () => {
  const reviews = [
    { reviewKey: "active", reviewPaneId: "w1:p2" },
    { reviewKey: "stale", reviewPaneId: "w1:p3" },
  ];

  assert.deepEqual(
    activeReviews(reviews, new Set(["w1:p2"])).map(
      (review) => review.reviewKey,
    ),
    ["active"],
  );
});

test("userNotesFromReview excludes AI and agent annotations", () => {
  const notes = userNotesFromReview({
    reviewNotes: [
      { source: "ai", body: "rationale" },
      { source: "agent", body: "agent comment" },
      {
        source: "agent",
        author: "user (restored)",
        body: "restored comment",
        filePath: "src/restored.js",
      },
      { source: "user", body: "please fix", filePath: "src/a.js" },
    ],
  });
  assert.deepEqual(notes, [
    {
      source: "agent",
      author: "user (restored)",
      body: "restored comment",
      filePath: "src/restored.js",
    },
    { source: "user", body: "please fix", filePath: "src/a.js" },
  ]);
});

test("restoreCommentsFromReview preserves note text and location", () => {
  assert.deepEqual(
    restoreCommentsFromReview({
      reviewNotes: [
        {
          source: "user",
          filePath: "src/a.js",
          body: "Check this line.",
          newRange: [12, 12],
        },
        {
          source: "user",
          filePath: "src/b.js",
          body: "Check this hunk.",
          hunkIndex: 1,
        },
      ],
    }),
    [
      {
        filePath: "src/a.js",
        summary: "Check this line.",
        author: "user (restored)",
        newLine: 12,
      },
      {
        filePath: "src/b.js",
        summary: "Check this hunk.",
        author: "user (restored)",
        hunk: 2,
      },
    ],
  );
});

test("unwrapHunkReviewResponse accepts Hunk's CLI response envelope", () => {
  const model = { sessionId: "session-1", reviewNotes: [] };
  assert.equal(unwrapHunkReviewResponse({ review: model }), model);
  assert.equal(unwrapHunkReviewResponse(model), model);
  assert.throws(
    () => unwrapHunkReviewResponse({ review: [] }),
    /invalid review model/,
  );
});

test("findHunkSessionId selects the exact Hunk process in a shared repo", () => {
  const response = {
    sessions: [
      { sessionId: "older", pid: 101, repoRoot: "/repo" },
      { sessionId: "current", pid: 202, repoRoot: "/repo" },
      { sessionId: "other", pid: 202, repoRoot: "/other" },
    ],
  };

  assert.equal(findHunkSessionId(response, 202, "/repo"), "current");
  assert.equal(findHunkSessionId(response, 303, "/repo"), undefined);
});

test("findHunkSessionIdByLaunch selects a legacy session by opening time", () => {
  const response = {
    sessions: [
      {
        sessionId: "older",
        repoRoot: "/repo",
        launchedAt: "2026-07-27T18:21:05.000Z",
      },
      {
        sessionId: "current",
        repoRoot: "/repo",
        launchedAt: "2026-07-27T18:22:06.100Z",
      },
    ],
  };

  assert.equal(
    findHunkSessionIdByLaunch(
      response,
      "/repo",
      "2026-07-27T18:22:05.700Z",
    ),
    "current",
  );
  assert.equal(
    findHunkSessionIdByLaunch(
      response,
      "/repo",
      "2026-07-27T19:00:00.000Z",
    ),
    undefined,
  );
});

test("formatNoteLocation renders new ranges and one-based hunk numbers", () => {
  assert.equal(
    formatNoteLocation({
      filePath: "src/a.js",
      newRange: [10, 12],
    }),
    "src/a.js, new lines 10-12",
  );
  assert.equal(
    formatNoteLocation({ filePath: "src/a.js", hunkIndex: 1 }),
    "src/a.js, hunk 2",
  );
});

test("buildAgentPrompt includes every human note with its location", () => {
  const prompt = buildAgentPrompt(
    [
      {
        filePath: "src/a.js",
        newRange: [7, 1],
        title: "Validation",
        body: "Handle an empty value.",
      },
      {
        filePath: "test/a.test.js",
        hunkIndex: 0,
        body: "Add a regression test.",
      },
    ],
    "/repo",
  );

  assert.match(prompt, /Репозиторий: \/repo/);
  assert.match(prompt, /src\/a\.js, new lines 7 — Validation/);
  assert.match(prompt, /Handle an empty value/);
  assert.match(prompt, /test\/a\.test\.js, hunk 1/);
});

test("state and snapshots are written atomically and remain readable", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "herdr-hunk-state-"));
  const state = upsertReview(
    readState(stateDir),
    {
      reviewKey: "review-1",
      reviewPaneId: "w1:p2",
      agentPaneId: "w1:p1",
      openedAt: "2026-01-01T00:00:00.000Z",
    },
  );
  writeState(stateDir, state);

  assert.equal(readState(stateDir).reviews[0].reviewKey, "review-1");

  const snapshotPath = getSnapshotPath(stateDir, "review-1");
  writeJsonAtomic(snapshotPath, { review: { reviewNotes: [] } });
  assert.deepEqual(JSON.parse(readFileSync(snapshotPath, "utf8")), {
    review: { reviewNotes: [] },
  });
});
