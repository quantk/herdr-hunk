import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  activeReviews,
  buildAgentPrompt,
  compactReviews,
  formatNoteLocation,
  getSnapshotPath,
  loadPromptTemplate,
  parseContext,
  readState,
  reviewsForAgent,
  selectReview,
  upsertReview,
  withStateLock,
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

test("selectReview prioritizes exact matches and rejects ambiguous fallbacks", () => {
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
  assert.throws(
    () => selectReview(reviews, { workspace_id: "w1" }),
    /Several active reviews/,
  );
  assert.equal(selectReview([reviews[1]], { workspace_id: "w1" }).reviewKey, "newer");
  assert.throws(
    () =>
      selectReview(reviews, {
        workspace_id: "w1",
        focused_pane_cwd: "/repo",
      }),
    /Several active reviews/,
  );
});

test("selectReview applies unique workspace/repository, repository, and global fallbacks in order", () => {
  const reviews = [
    {
      reviewKey: "target",
      reviewPaneId: "w2:p2",
      agentPaneId: "w2:p1",
      workspaceId: "w2",
      repo: "/target",
    },
    {
      reviewKey: "other",
      reviewPaneId: "w3:p2",
      agentPaneId: "w3:p1",
      workspaceId: "w3",
      repo: "/other",
    },
  ];
  assert.equal(
    selectReview(reviews, {
      workspace_id: "w2",
      focused_pane_cwd: "/target",
    }).reviewKey,
    "target",
  );
  assert.equal(
    selectReview(reviews, {
      workspace_id: "unknown",
      focused_pane_cwd: "/target",
    }).reviewKey,
    "target",
  );
  assert.equal(
    selectReview([reviews[1]], { workspace_id: "unknown" }).reviewKey,
    "other",
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
    {
      reviewKey: "active",
      reviewPaneId: "w1:p2",
      agentPaneId: "w1:p1",
    },
    {
      reviewKey: "stale-review",
      reviewPaneId: "w1:p3",
      agentPaneId: "w1:p1",
    },
    {
      reviewKey: "stale-agent",
      reviewPaneId: "w1:p2",
      agentPaneId: "w1:p4",
    },
  ];

  assert.deepEqual(
    activeReviews(reviews, new Set(["w1:p1", "w1:p2"])).map(
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

test("unwrapHunkReviewResponse accepts Hunk's CLI response envelope", () => {
  const model = { sessionId: "session-1", reviewNotes: [] };
  assert.equal(unwrapHunkReviewResponse({ review: model }), model);
  assert.equal(unwrapHunkReviewResponse(model), model);
  assert.throws(
    () => unwrapHunkReviewResponse({ review: [] }),
    /invalid review model/,
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

  assert.match(prompt, /Repository: \/repo/);
  assert.match(prompt, /src\/a\.js, new lines 7 — Validation/);
  assert.match(prompt, /Handle an empty value/);
  assert.match(prompt, /test\/a\.test\.js, hunk 1/);
});

test("buildAgentPrompt renders a custom template", () => {
  const prompt = buildAgentPrompt(
    [
      {
        filePath: "src/a.js",
        newRange: [7, 7],
        body: "Handle an empty value.",
      },
    ],
    "/repo",
    "{{note_count}} note for {{repository}}\n\n{{notes}}",
  );

  assert.equal(
    prompt,
    "1 note for /repo\n\n### 1. src/a.js, new lines 7\nHandle an empty value.",
  );
  assert.throws(
    () => buildAgentPrompt([], "/repo", "{{repository}}"),
    /must contain the \{\{notes\}\} placeholder/,
  );
  assert.throws(
    () => buildAgentPrompt([], "/repo", "{{notes}}\n{{unknown}}"),
    /unknown placeholder: \{\{unknown\}\}/,
  );
});

test("loadPromptTemplate uses the default or a configured file", () => {
  const configDir = mkdtempSync(join(tmpdir(), "herdr-hunk-config-"));
  assert.match(loadPromptTemplate(configDir), /I finished reviewing/);

  writeFileSync(
    join(configDir, "prompt-template.md"),
    "Custom\n\n{{notes}}\n",
  );
  assert.equal(loadPromptTemplate(configDir), "Custom\n\n{{notes}}");

  writeFileSync(join(configDir, "prompt-template.md"), " \n");
  assert.throws(
    () => loadPromptTemplate(configDir),
    /prompt-template\.md is empty/,
  );
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

test("state lock rejects overlapping actions and releases after completion", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "herdr-lock-"));
  assert.throws(
    () =>
      withStateLock(stateDir, () =>
        withStateLock(stateDir, () => undefined)
      ),
    /Another review action is already running/,
  );
  assert.equal(withStateLock(stateDir, () => 42), 42);
});

test("review compaction removes records whose panes are both gone", () => {
  const reviews = [
    { agentPaneId: "agent-live", reviewPaneId: "review-gone" },
    { agentPaneId: "agent-gone", reviewPaneId: "review-live" },
    { agentPaneId: "agent-gone", reviewPaneId: "review-gone" },
  ];
  assert.deepEqual(
    compactReviews(reviews, new Set(["agent-live", "review-live"])),
    reviews.slice(0, 2),
  );
});
