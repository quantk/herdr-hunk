import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  readState,
  upsertReview,
  writeState,
} from "../src/common.mjs";
import {
  createHumanNote,
  emptyStore,
  saveStore,
} from "../src/review/store.mjs";
import { contextHash } from "../src/review/anchors.mjs";

function createFakeHerdr(directory) {
  const path = join(directory, "fake-herdr.mjs");
  writeFileSync(
    path,
    `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const root = process.env.HERDR_FAKE_DATA;
const args = process.argv.slice(2);
appendFileSync(root + "/commands.jsonl", JSON.stringify(args) + "\\n");
const paneStatePath = root + "/pane-state.json";
const paneState = existsSync(paneStatePath)
  ? JSON.parse(readFileSync(paneStatePath, "utf8"))
  : { reviewTab: "tab-main" };
const reply = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
if (args[0] === "pane" && args[1] === "get") {
  const id = args[2];
  if (id === "w1:p1") reply({ result: { pane: { pane_id: id, tab_id: "tab-main", workspace_id: "w1" } } });
  else if (id === "w1:p2") reply({ result: { pane: { pane_id: id, tab_id: paneState.reviewTab, workspace_id: "w1" } } });
  else process.exitCode = 1;
} else if (args[0] === "pane" && args[1] === "move") {
  paneState.reviewTab = args.includes("--new-tab")
    ? "tab-background"
    : args[args.indexOf("--tab") + 1];
  writeFileSync(paneStatePath, JSON.stringify(paneState));
  reply({ result: { move_result: { pane: { pane_id: "w1:p2" } } } });
} else if (args[0] === "pane" && args[1] === "list") {
  reply({ result: { panes: [{ pane_id: "w1:p1" }, { pane_id: "w1:p2" }] } });
} else if (args[0] === "plugin" && args[1] === "pane" && args[2] === "open") {
  writeFileSync(paneStatePath, JSON.stringify({ reviewTab: "tab-main" }));
  reply({ result: { plugin_pane: { pane: { pane_id: "w1:p2", workspace_id: "w1" } } } });
} else if (args[0] === "agent" && args[1] === "focus") {
  reply({ result: { pane_id: args[2] } });
} else if (args[0] === "notification" && args[1] === "show") {
  reply({ result: {} });
} else {
  process.stderr.write("unexpected fake Herdr command: " + args.join(" ") + "\\n");
  process.exitCode = 2;
}
`,
  );
  chmodSync(path, 0o755);
  return path;
}

function actionEnv({ repo, stateDir, fakeHerdr, fakeData, socketPath, context }) {
  return {
    ...process.env,
    HERDR_BIN_PATH: fakeHerdr,
    HERDR_FAKE_DATA: fakeData,
    HERDR_PLUGIN_ID: "quantick.hunk-review",
    HERDR_PLUGIN_STATE_DIR: stateDir,
    HERDR_PLUGIN_CONFIG_DIR: join(fakeData, "config"),
    HERDR_SOCKET_PATH: socketPath,
    HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({
      workspace_id: "w1",
      workspace_cwd: repo,
      focused_pane_cwd: repo,
      ...context,
    }),
  };
}

test("F6 opens, hides, and restores the same native pane without a close or Hunk command", () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-actions-f6-"));
  const repo = join(root, "repo");
  const stateDir = join(root, "state");
  mkdirSync(repo);
  spawnSync("git", ["init", "-q", repo]);
  const fakeHerdr = createFakeHerdr(root);
  const env = actionEnv({
    repo,
    stateDir,
    fakeHerdr,
    fakeData: root,
    context: {
      focused_pane_id: "w1:p1",
      focused_pane_agent: "codex",
    },
  });

  for (let count = 0; count < 3; count += 1) {
    const result = spawnSync(process.execPath, ["src/open-review.mjs"], {
      cwd: process.cwd(),
      env,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
  }

  const state = readState(stateDir);
  assert.equal(state.reviews.length, 1);
  assert.equal(state.reviews[0].reviewPaneId, "w1:p2");
  const commands = readFileSync(join(root, "commands.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.equal(
    commands.filter((args) => args.slice(0, 3).join(" ") === "plugin pane open").length,
    1,
  );
  assert.equal(
    commands.filter((args) => args.slice(0, 2).join(" ") === "pane move").length,
    2,
  );
  assert.equal(commands.some((args) => args.includes("close")), false);
  assert.equal(commands.some((args) => args[0] === "hunk"), false);
});

test("F7 loads the exact native store and inserts one unsubmitted human-only draft", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-actions-f7-"));
  const repo = join(root, "repo");
  const stateDir = join(root, "state");
  const configDir = join(root, "config");
  mkdirSync(repo);
  mkdirSync(configDir);
  spawnSync("git", ["init", "-q", repo]);
  const fakeHerdr = createFakeHerdr(root);
  writeState(
    stateDir,
    upsertReview(
      { version: 1, reviews: [] },
      {
        reviewKey: "review-f7",
        repo,
        agentPaneId: "w1:p1",
        agentKind: "codex",
        reviewPaneId: "w1:p2",
        workspaceId: "w1",
        openedAt: new Date().toISOString(),
      },
    ),
  );
  const selectedText = ["const value = 2;"];
  const note = createHumanNote("Working-tree note must stay out.", {
    path: "src/a.js",
    previousPath: null,
    side: "new",
    startLine: 2,
    endLine: 2,
    selectedText,
    contextBefore: ["const before = true;"],
    contextAfter: [],
    contextHash: contextHash(
      selectedText,
      ["const before = true;"],
      [],
    ),
    diffGeneration: 1,
  });
  const branchNote = createHumanNote(
    "Use a clearer name.",
    note.anchor,
    "",
    "branch",
  );
  saveStore(stateDir, {
    ...emptyStore("review-f7", repo),
    ui: {
      ...emptyStore("review-f7", repo).ui,
      scope: "branch",
    },
    notes: [note, branchNote],
  });

  const socketPath = join(root, "herdr.sock");
  let request;
  const server = createServer((socket) => {
    let input = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      input += chunk;
      if (!input.includes("\n")) return;
      request = JSON.parse(input.slice(0, input.indexOf("\n")));
      socket.end(`${JSON.stringify({ id: request.id, result: {} })}\n`);
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });

  const env = actionEnv({
    repo,
    stateDir,
    fakeHerdr,
    fakeData: root,
    socketPath,
    context: { focused_pane_id: "w1:p1", focused_pane_agent: "codex" },
  });
  const child = spawn(process.execPath, ["src/send-notes.mjs"], {
    cwd: process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const code = await new Promise((resolve) => child.once("exit", resolve));
  await new Promise((resolve) => server.close(resolve));

  assert.equal(code, 0, stderr);
  assert.equal(request.method, "pane.send_input");
  assert.equal(request.params.pane_id, "w1:p1");
  assert.deepEqual(request.params.keys, []);
  assert.match(request.params.text, /src\/a\.js, new lines 2/);
  assert.match(request.params.text, /Use a clearer name/);
  assert.doesNotMatch(request.params.text, /Working-tree note must stay out/);
  assert.match(request.params.text, /const value = 2/);
  assert.doesNotMatch(request.params.text, /\nEnter\b/);
});
