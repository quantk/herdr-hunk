import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAnchor, reanchorNote } from "../src/review/anchors.mjs";
import { parseUnifiedDiff } from "../src/review/parse-diff.mjs";
import {
  createHumanNote,
  emptyStore,
  readStore,
  saveStore,
  validateStore,
} from "../src/review/store.mjs";
import { getSnapshotPath } from "../src/common.mjs";

function model(content, generation = 1) {
  return parseUnifiedDiff(
    [
      "diff --git a/a.js b/a.js",
      "--- a/a.js",
      "+++ b/a.js",
      "@@ -1,3 +1,3 @@",
      ...content,
    ].join("\n"),
    { generation },
  );
}

test("anchors preserve exact ranges, re-anchor uniquely, and go stale on ambiguity", () => {
  const initial = model([" before", "-old", "+new", " after"]);
  const file = initial.files[0];
  const row = file.rows.find((candidate) => candidate.kind === "addition");
  const anchor = createAnchor(file, [row], 1);
  const note = createHumanNote("Fix this.", anchor);

  const moved = model([" prefix", " before", "-old", "+new", " after"], 2);
  const anchored = reanchorNote(note, moved);
  assert.equal(anchored.status, "anchored");
  assert.equal(anchored.anchor.startLine, 3);

  const renamed = parseUnifiedDiff(
    [
      "diff --git a/a.js b/renamed.js",
      "similarity index 80%",
      "rename from a.js",
      "rename to renamed.js",
      "--- a/a.js",
      "+++ b/renamed.js",
      "@@ -1,3 +1,3 @@",
      " before",
      "-old",
      "+new",
      " after",
    ].join("\n"),
    { generation: 3 },
  );
  assert.equal(reanchorNote(note, renamed).anchor.path, "renamed.js");

  const ambiguous = model(
    ["+new", " context", "+new", " another"],
    4,
  );
  assert.equal(reanchorNote(note, ambiguous).status, "stale");
});

test("store validates human provenance and saves Unicode atomically", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "herdr-native-store-"));
  const repository = "/repo";
  const reviewKey = "review-1";
  const diff = model([" same", "-old", "+new", " tail"]);
  const row = diff.files[0].rows.find((candidate) => candidate.kind === "addition");
  const note = createHumanNote(
    "Многострочный\nкомментарий",
    createAnchor(diff.files[0], [row], 1),
  );
  const saved = saveStore(stateDir, {
    ...emptyStore(reviewKey, repository),
    notes: [note],
  });
  assert.equal(readStore(stateDir, reviewKey, repository).notes[0].body, note.body);
  assert.equal(
    statSync(getSnapshotPath(stateDir, reviewKey)).mode & 0o777,
    0o600,
  );
  assert.match(saved.updatedAt, /^20/);
  assert.throws(
    () =>
      validateStore(
        { ...saved, notes: [{ ...note, provenance: "agent" }] },
        reviewKey,
        repository,
      ),
    /provenance must be human/,
  );
  assert.throws(
    () =>
      validateStore(
        {
          ...saved,
          notes: [
            {
              ...note,
              anchor: { ...note.anchor, contextHash: "forged" },
            },
          ],
        },
        reviewKey,
        repository,
      ),
    /context hash does not match/,
  );
});

test("legacy migration keeps only human notes, backs up once, and marks unknown anchors stale", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "herdr-native-migrate-"));
  const path = getSnapshotPath(stateDir, "review-2");
  mkdirSync(join(stateDir, "snapshots"));
  const legacy = {
    review: {
      reviewNotes: [
        {
          source: "user",
          body: "Keep me.",
          filePath: "a.js",
          newRange: [2, 2],
          selectedText: ["new"],
        },
        { source: "ai", body: "Drop me.", filePath: "a.js" },
      ],
    },
  };
  writeFileSync(path, JSON.stringify(legacy), { encoding: "utf8", flag: "wx" });
  const store = readStore(stateDir, "review-2", "/repo");
  assert.equal(store.notes.length, 1);
  assert.equal(store.notes[0].provenance, "human");
  assert.equal(store.notes[0].status, "stale");
  assert.equal(JSON.parse(readFileSync(path, "utf8")).version, 2);
  assert.ok(existsSync(`${path}.v1.bak`));
  assert.equal(readStore(stateDir, "review-2", "/repo").notes.length, 1);
});
