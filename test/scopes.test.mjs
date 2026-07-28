import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeScope,
  noteMatchesScope,
} from "../src/review/scopes.mjs";

test("scope matching isolates last-turn comments by the exact baseline", () => {
  const note = { scope: "last-turn", scopeBase: "tree-a" };
  assert.equal(noteMatchesScope(note, "last-turn", "tree-a"), true);
  assert.equal(noteMatchesScope(note, "last-turn", "tree-b"), false);
  assert.equal(noteMatchesScope(note, "branch", null), false);
});

test("unknown legacy scopes normalize to uncommitted", () => {
  assert.equal(normalizeScope("unknown"), "uncommitted");
  assert.equal(noteMatchesScope({}, "uncommitted"), true);
});
