import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentTurnTracker,
  parseAgentStatus,
} from "../src/review/turn-tracker.mjs";

function fakeSource(trees) {
  const refs = new Map();
  return {
    baseline: null,
    target: null,
    async snapshotWorktree() {
      return trees.shift();
    },
    async readTreeRef(ref) {
      return refs.get(ref) ?? null;
    },
    async writeTreeRef(ref, tree) {
      refs.set(ref, tree);
    },
    async deleteTreeRef(ref) {
      refs.delete(ref);
    },
    setTurnBaseline(tree) {
      this.baseline = tree;
    },
    setTurnTarget(tree) {
      this.target = tree;
    },
  };
}

test("turn tracker promotes the start snapshot only after a turn changes files", async () => {
  const source = fakeSource(["turn-start", "turn-start", "turn-changed"]);
  const tracker = new AgentTurnTracker({
    source,
    agentPaneId: "w1:p1",
    reviewKey: "review-turn",
  });
  const statuses = ["idle", "working", "working", "working"];
  tracker.readStatus = async () => statuses.shift();
  await tracker.initialize();

  assert.equal(await tracker.sample(), false);
  assert.equal(await tracker.sample(), false);
  assert.equal(await tracker.sample(), false);
  assert.equal(source.baseline, null);
  assert.equal(await tracker.sample(), true);
  assert.equal(source.baseline, "turn-start");
  assert.equal(source.target, "turn-changed");
});

test("turn tracker keeps the previous baseline after a no-change turn", async () => {
  const source = fakeSource(["turn-start", "turn-start"]);
  source.writeTreeRef(
    "refs/herdr-hunk/turn-base/review-turn",
    "previous-turn",
  );
  const tracker = new AgentTurnTracker({
    source,
    agentPaneId: "w1:p1",
    reviewKey: "review-turn",
  });
  const statuses = ["idle", "working", "idle"];
  tracker.readStatus = async () => statuses.shift();
  await tracker.initialize();

  await tracker.sample();
  await tracker.sample();
  await tracker.sample();
  assert.equal(source.baseline, "previous-turn");
});

test("turn tracking reads only the exact associated agent pane", () => {
  const response = JSON.stringify({
    result: {
      agents: [
        { pane_id: "w1:p1", agent_status: "working" },
        { pane_id: "w1:p2", agent_status: "idle" },
      ],
    },
  });
  assert.equal(parseAgentStatus(response, "w1:p2"), "idle");
  assert.equal(parseAgentStatus(response, "missing"), "unknown");
});

test("turn tracker freezes the target after the agent returns to idle", async () => {
  const trees = ["turn-start", "during-turn", "turn-end"];
  const source = fakeSource(trees);
  const tracker = new AgentTurnTracker({
    source,
    agentPaneId: "w1:p1",
    reviewKey: "review-turn",
  });
  const statuses = ["idle", "working", "working", "idle", "idle"];
  tracker.readStatus = async () => statuses.shift();
  await tracker.initialize();

  await tracker.sample();
  await tracker.sample();
  await tracker.sample();
  await tracker.sample();
  assert.equal(source.baseline, "turn-start");
  assert.equal(source.target, "turn-end");
  await tracker.sample();
  assert.equal(source.target, "turn-end");
  assert.equal(trees.length, 0);
});
