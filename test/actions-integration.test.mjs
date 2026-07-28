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
  readStore,
  saveStore,
} from "../src/review/store.mjs";
import { contextHash } from "../src/review/anchors.mjs";

function createFakeHerdr(directory) {
  const path = join(directory, "fake-herdr.mjs");
  writeFileSync(
    path,
    `#!/usr/bin/env node
	import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
const root = process.env.HERDR_FAKE_DATA;
const args = process.argv.slice(2);
appendFileSync(root + "/commands.jsonl", JSON.stringify(args) + "\\n");
const paneStatePath = root + "/pane-state.json";
const paneState = existsSync(paneStatePath)
  ? JSON.parse(readFileSync(paneStatePath, "utf8"))
  : { reviewTab: "tab-review", focusedTab: "tab-main" };
const reply = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
if (args[0] === "pane" && args[1] === "get") {
  const id = args[2];
  if (process.env.HERDR_FAKE_PANE_NOT_FOUND === id) {
    process.stderr.write(JSON.stringify({
      id: "cli:pane:get",
      error: { code: "pane_not_found", message: "pane " + id + " not found" },
    }) + "\\n");
    process.exitCode = 1;
  }
  else if (process.env.HERDR_FAKE_PANE_GET_ERROR === id) {
    reply({ error: { code: "temporary_failure", message: "temporary pane lookup failure" } });
    process.exitCode = 1;
  }
  else if (id === "w1:p1") reply({ result: { pane: { pane_id: id, tab_id: "tab-main", workspace_id: "w1" } } });
  else if (id === "w1:p2") reply({ result: { pane: { pane_id: id, tab_id: paneState.reviewTab, workspace_id: "w1" } } });
  else process.exitCode = 1;
} else if (args[0] === "tab" && args[1] === "focus") {
  paneState.focusedTab = args[2];
  writeFileSync(paneStatePath, JSON.stringify(paneState));
  reply({ result: { tab: { tab_id: args[2], focused: true } } });
} else if (args[0] === "tab" && args[1] === "rename") {
  paneState.reviewLabel = args.slice(3).join(" ");
  writeFileSync(paneStatePath, JSON.stringify(paneState));
  reply({ result: { tab: { tab_id: args[2], label: paneState.reviewLabel } } });
} else if (args[0] === "pane" && args[1] === "move" && args.includes("--new-tab")) {
  paneState.reviewTab = "tab-review";
  if (args.includes("--focus")) paneState.focusedTab = "tab-review";
  writeFileSync(paneStatePath, JSON.stringify(paneState));
  reply({ result: { move_result: { pane: { pane_id: args[2], tab_id: "tab-review" } } } });
} else if (args[0] === "pane" && args[1] === "list") {
  reply({ result: { panes: [
    {
      pane_id: "w1:p1",
      workspace_id: "w1",
      agent: "codex",
      cwd: process.env.HERDR_FAKE_AGENT_CWD,
      foreground_cwd: process.env.HERDR_FAKE_AGENT_CWD,
    },
    { pane_id: "w1:p2", workspace_id: "w1" },
  ] } });
} else if (args[0] === "plugin" && args[1] === "pane" && args[2] === "open") {
  writeFileSync(paneStatePath, JSON.stringify({ reviewTab: "tab-review", focusedTab: "tab-review" }));
  if (process.env.HERDR_FAKE_BREAK_STATE_AFTER_OPEN === "1") {
    mkdirSync(process.env.HERDR_PLUGIN_STATE_DIR + "/reviews.json");
  }
  reply({ result: { plugin_pane: { pane: { pane_id: "w1:p2", tab_id: "tab-review", workspace_id: "w1" } } } });
} else if (args[0] === "plugin" && args[1] === "pane" && args[2] === "close") {
  reply({ result: { closed: args[3] } });
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
    HERDR_FAKE_AGENT_CWD: repo,
    HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({
      workspace_id: "w1",
      workspace_cwd: repo,
      focused_pane_cwd: repo,
      ...context,
    }),
  };
}

test("F6 opens a dedicated review tab and toggles focus without moving or closing its pane", () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-actions-f6-"));
  const repo = join(root, "repo");
  const stateDir = join(root, "state");
  mkdirSync(repo);
  spawnSync("git", ["init", "-q", repo]);
  const fakeHerdr = createFakeHerdr(root);
  const runAction = (context) => {
    const result = spawnSync(process.execPath, ["src/open-review.mjs"], {
      cwd: process.cwd(),
      env: actionEnv({
        repo,
        stateDir,
        fakeHerdr,
        fakeData: root,
        context,
      }),
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
  };
  runAction({
    focused_pane_id: "w1:p1",
    focused_pane_agent: "codex",
  });
  runAction({ focused_pane_id: "w1:p2" });
  runAction({
    focused_pane_id: "w1:p1",
    focused_pane_agent: "codex",
  });

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
    commands.filter((args) => args.slice(0, 2).join(" ") === "tab focus").length,
    2,
  );
  const open = commands.find(
    (args) => args.slice(0, 3).join(" ") === "plugin pane open",
  );
  assert.equal(open[open.indexOf("--placement") + 1], "tab");
  assert.equal(open[open.indexOf("--workspace") + 1], "w1");
  assert.equal(open.includes("--target-pane"), false);
  assert.equal(
    commands.some((args) => args.slice(0, 2).join(" ") === "pane move"),
    false,
  );
  assert.equal(commands.some((args) => args.includes("close")), false);
  assert.equal(commands.some((args) => args[0] === "hunk"), false);
  assert.deepEqual(
    commands
      .filter((args) => args.slice(0, 2).join(" ") === "tab focus")
      .map((args) => args[2]),
    ["tab-main", "tab-review"],
  );
  assert.deepEqual(
    commands
      .filter((args) => args.slice(0, 2).join(" ") === "tab rename")
      .map((args) => args.slice(2)),
    [
      ["tab-review", "Review"],
      ["tab-review", "Review"],
      ["tab-review", "Review"],
    ],
  );
});

test("F6 migrates an existing split review into a dedicated tab without restarting it", () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-actions-f6-migrate-"));
  const repo = join(root, "repo");
  const stateDir = join(root, "state");
  mkdirSync(repo);
  spawnSync("git", ["init", "-q", repo]);
  const fakeHerdr = createFakeHerdr(root);
  writeFileSync(
    join(root, "pane-state.json"),
    JSON.stringify({ reviewTab: "tab-main", focusedTab: "tab-main" }),
  );
  writeState(
    stateDir,
    upsertReview(
      { version: 1, reviews: [] },
      {
        reviewKey: "legacy-split",
        repo,
        agentPaneId: "w1:p1",
        agentKind: "codex",
        reviewPaneId: "w1:p2",
        workspaceId: "w1",
        openedAt: new Date().toISOString(),
      },
    ),
  );

  const result = spawnSync(process.execPath, ["src/open-review.mjs"], {
    cwd: process.cwd(),
    env: actionEnv({
      repo,
      stateDir,
      fakeHerdr,
      fakeData: root,
      context: {
        focused_pane_id: "w1:p1",
        focused_pane_agent: "codex",
      },
    }),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);

  const commands = readFileSync(join(root, "commands.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse);
  const move = commands.find(
    (args) => args.slice(0, 2).join(" ") === "pane move",
  );
  assert.ok(move);
  assert.equal(move.includes("--new-tab"), true);
  assert.equal(move.includes("--focus"), true);
  assert.equal(move[move.indexOf("--label") + 1], "Review");
  assert.equal(
    commands.some(
      (args) => args.slice(0, 3).join(" ") === "plugin pane open",
    ),
    false,
  );
  assert.equal(
    JSON.parse(readFileSync(join(root, "pane-state.json"), "utf8")).reviewTab,
    "tab-review",
  );
});

test("F6 fails closed on a transient pane lookup error", () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-actions-f6-lookup-"));
  const repo = join(root, "repo");
  const stateDir = join(root, "state");
  mkdirSync(repo);
  spawnSync("git", ["init", "-q", repo]);
  const fakeHerdr = createFakeHerdr(root);
  writeState(
    stateDir,
    upsertReview(
      { version: 1, reviews: [] },
      {
        reviewKey: "lookup-failure",
        repo,
        agentPaneId: "w1:p1",
        agentKind: "codex",
        reviewPaneId: "w1:p2",
        workspaceId: "w1",
        openedAt: new Date().toISOString(),
      },
    ),
  );
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
  env.HERDR_FAKE_PANE_GET_ERROR = "w1:p2";
  const result = spawnSync(process.execPath, ["src/open-review.mjs"], {
    cwd: process.cwd(),
    env,
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /temporary pane lookup failure/);
  const commands = readFileSync(join(root, "commands.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.equal(
    commands.some((args) => args.slice(0, 3).join(" ") === "plugin pane open"),
    false,
  );
});

test("F6 replaces a review pane that exited through Ctrl+C", () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-actions-f6-stale-pane-"));
  const repo = join(root, "repo");
  const stateDir = join(root, "state");
  mkdirSync(repo);
  spawnSync("git", ["init", "-q", repo]);
  const fakeHerdr = createFakeHerdr(root);
  writeState(
    stateDir,
    upsertReview(
      { version: 1, reviews: [] },
      {
        reviewKey: "preserved-review-key",
        repo,
        agentPaneId: "w1:p1",
        agentKind: "codex",
        reviewPaneId: "w1:p2",
        workspaceId: "w1",
        openedAt: new Date().toISOString(),
      },
    ),
  );
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
  env.HERDR_FAKE_PANE_NOT_FOUND = "w1:p2";
  const result = spawnSync(process.execPath, ["src/open-review.mjs"], {
    cwd: process.cwd(),
    env,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Opened a review tab/);
  assert.equal(readState(stateDir).reviews[0].reviewKey, "preserved-review-key");
  const commands = readFileSync(join(root, "commands.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.equal(
    commands.filter(
      (args) => args.slice(0, 3).join(" ") === "plugin pane open",
    ).length,
    1,
  );
});

test("F6 closes a newly opened pane when association persistence fails", () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-actions-f6-rollback-"));
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
  env.HERDR_FAKE_BREAK_STATE_AFTER_OPEN = "1";
  const result = spawnSync(process.execPath, ["src/open-review.mjs"], {
    cwd: process.cwd(),
    env,
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  const commands = readFileSync(join(root, "commands.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.equal(
    commands.some(
      (args) => args.slice(0, 3).join(" ") === "plugin pane close",
    ),
    true,
  );
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
  const resolvedBranchNote = {
    ...createHumanNote(
      "Already fixed; do not repeat.",
      note.anchor,
      "",
      "branch",
    ),
    resolvedAt: new Date().toISOString(),
  };
  saveStore(stateDir, {
    ...emptyStore("review-f7", repo),
    ui: {
      ...emptyStore("review-f7", repo).ui,
      scope: "branch",
    },
    notes: [note, branchNote, resolvedBranchNote],
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
  assert.doesNotMatch(request.params.text, /Already fixed; do not repeat/);
  assert.doesNotMatch(request.params.text, /Working-tree note must stay out/);
  assert.match(request.params.text, /const value = 2/);
  assert.doesNotMatch(request.params.text, /\nEnter\b/);
  assert.equal(
    readStore(stateDir, "review-f7", repo).notes.find(
      (candidate) => candidate.id === branchNote.id,
    ).resolvedAt,
    null,
  );
});

test("F7 rejects a source agent that moved to another repository", () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-actions-f7-repo-"));
  const repo = join(root, "repo");
  const otherRepo = join(root, "other");
  const stateDir = join(root, "state");
  mkdirSync(repo);
  mkdirSync(otherRepo);
  spawnSync("git", ["init", "-q", repo]);
  spawnSync("git", ["init", "-q", otherRepo]);
  const fakeHerdr = createFakeHerdr(root);
  writeState(
    stateDir,
    upsertReview(
      { version: 1, reviews: [] },
      {
        reviewKey: "review-moved",
        repo,
        agentPaneId: "w1:p1",
        agentKind: "codex",
        reviewPaneId: "w1:p2",
        workspaceId: "w1",
        openedAt: new Date().toISOString(),
      },
    ),
  );
  const env = actionEnv({
    repo,
    stateDir,
    fakeHerdr,
    fakeData: root,
    context: { focused_pane_id: "w1:p2" },
  });
  env.HERDR_FAKE_AGENT_CWD = otherRepo;
  const result = spawnSync(process.execPath, ["src/send-notes.mjs"], {
    cwd: process.cwd(),
    env,
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /different repository/);
  const commands = readFileSync(join(root, "commands.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.equal(
    commands.some((args) => args.slice(0, 2).join(" ") === "agent focus"),
    false,
  );
});
