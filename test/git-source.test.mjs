import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GitSource } from "../src/review/git-source.mjs";
import { AgentTurnTracker } from "../src/review/turn-tracker.mjs";

function git(repo, ...args) {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function createRepo() {
  const repo = mkdtempSync(join(tmpdir(), "herdr-native-git-"));
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  return repo;
}

function repositorySnapshot(repo) {
  return {
    status: git(repo, "status", "--porcelain=v1", "--untracked-files=all"),
    index: git(repo, "ls-files", "--stage"),
    refs: git(repo, "show-ref"),
    diff: git(repo, "diff", "--binary", "HEAD"),
    staged: git(repo, "diff", "--binary", "--cached", "HEAD"),
  };
}

test("GitSource combines staged, unstaged, renamed, untracked, binary, symlink, and large entries read-only", async () => {
  const repo = createRepo();
  const childRepo = createRepo();
  writeFileSync(join(childRepo, "lib.txt"), "library\n");
  git(childRepo, "add", ".");
  git(childRepo, "commit", "-qm", "library");
  writeFileSync(join(repo, "a.js"), "const value = 1;\n");
  writeFileSync(join(repo, "old name.txt"), "old\n");
  writeFileSync(join(repo, "tool.sh"), "#!/bin/sh\n");
  writeFileSync(join(repo, "deleted.txt"), "gone\n");
  writeFileSync(join(repo, ".gitignore"), "*.ignored\n");
  git(
    repo,
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "add",
    "-q",
    childRepo,
    "vendor/lib",
  );
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "initial");

  writeFileSync(join(repo, "a.js"), "const value = 2;\n");
  git(repo, "add", "a.js");
  writeFileSync(join(repo, "a.js"), "const value = 3;\n");
  git(repo, "mv", "old name.txt", "new name.txt");
  writeFileSync(join(repo, "new file.py"), "print('hello')\n");
  writeFileSync(join(repo, "binary.bin"), Buffer.from([0, 1, 2, 3]));
  writeFileSync(join(repo, "large.txt"), "x".repeat(2048));
  writeFileSync(join(repo, "hidden.ignored"), "ignored\n");
  chmodSync(join(repo, "tool.sh"), 0o755);
  unlinkSync(join(repo, "deleted.txt"));
  writeFileSync(join(repo, "vendor/lib/lib.txt"), "library changed\n");
  symlinkSync("a.js", join(repo, "link.js"));

  const before = repositorySnapshot(repo);
  const source = new GitSource(repo, {
    totalPatchBytes: 64 * 1024,
    fileBytes: 1024,
  });
  const firstFingerprint = (await source.status()).fingerprint;
  const model = await source.refresh(4);
  const after = repositorySnapshot(repo);
  assert.deepEqual(after, before);

  writeFileSync(join(repo, "a.js"), "const value = 4;\n");
  const secondFingerprint = (await source.status()).fingerprint;
  assert.notEqual(secondFingerprint, firstFingerprint);

  const byPath = new Map(model.files.map((file) => [file.path, file]));
  assert.ok(byPath.get("a.js").rows.some((row) => row.text.includes("value = 3")));
  assert.equal(byPath.get("new name.txt").status, "renamed");
  assert.equal(byPath.get("new file.py").status, "added");
  assert.equal(byPath.get("binary.bin").kind, "binary");
  assert.equal(byPath.get("large.txt").kind, "too-large");
  assert.equal(byPath.get("link.js").status, "added");
  assert.equal(byPath.get("link.js").header.some((line) => line.includes("120000")), true);
  assert.equal(byPath.get("tool.sh").kind, "mode");
  assert.equal(byPath.get("deleted.txt").status, "deleted");
  assert.equal(byPath.get("vendor/lib").kind, "submodule");
  assert.equal(byPath.has("hidden.ignored"), false);
});

test("GitSource supports an unborn repository without writing an index", async () => {
  const repo = createRepo();
  writeFileSync(join(repo, "first.txt"), "first\n");
  const beforeStatus = git(repo, "status", "--porcelain=v1");
  const model = await new GitSource(repo).refresh(1);
  assert.equal(model.files[0].path, "first.txt");
  assert.equal(model.files[0].status, "added");
  assert.equal(git(repo, "status", "--porcelain=v1"), beforeStatus);
});

test("GitSource preserves legal control characters in tracked and untracked paths", async () => {
  const repo = createRepo();
  const tracked = [
    "bell\u0007.txt",
    "back\bspace.txt",
    "vertical\u000btab.txt",
    "form\fbreak.txt",
  ];
  for (const path of tracked) writeFileSync(join(repo, path), "before\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "base");
  for (const path of tracked) writeFileSync(join(repo, path), "after\n");
  const untracked = "line\nbreak.txt";
  writeFileSync(join(repo, untracked), "new\n");

  const paths = new Set(
    (await new GitSource(repo).refresh(1)).files.map((file) => file.path),
  );
  for (const path of [...tracked, untracked]) {
    assert.equal(paths.has(path), true, JSON.stringify(path));
  }
});

test("GitSource branch scope includes committed, working-tree, and untracked changes from merge-base", async () => {
  const repo = createRepo();
  writeFileSync(join(repo, "committed.txt"), "base\n");
  writeFileSync(join(repo, "working.txt"), "base\n");
  writeFileSync(join(repo, "old.txt"), "rename\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "base");
  git(repo, "branch", "-M", "main");
  git(repo, "switch", "-qc", "feature");

  writeFileSync(join(repo, "committed.txt"), "feature\n");
  git(repo, "mv", "old.txt", "renamed.txt");
  git(repo, "add", "committed.txt");
  git(repo, "commit", "-qm", "feature change");
  writeFileSync(join(repo, "working.txt"), "working tree\n");
  writeFileSync(join(repo, "untracked.txt"), "new\n");

  const source = new GitSource(repo);
  source.setScope("branch");
  const model = await source.refresh(1);
  const paths = new Set(model.files.map((file) => file.path));

  assert.equal(source.branchBaseLabel, "main");
  assert.equal(paths.has("committed.txt"), true);
  assert.equal(paths.has("working.txt"), true);
  assert.equal(paths.has("untracked.txt"), true);
  assert.equal(
    model.files.find((file) => file.path === "renamed.txt")?.status,
    "renamed",
  );
});

test("GitSource last-turn scope compares worktree trees across an agent commit", async () => {
  const repo = createRepo();
  writeFileSync(join(repo, "value.txt"), "before\n");
  writeFileSync(join(repo, ".gitignore"), "*.ignored\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "base");

  const source = new GitSource(repo);
  const baseline = await source.snapshotWorktree();
  const testRef = "refs/herdr-hunk/test/last-turn";
  await source.writeTreeRef(testRef, baseline);
  assert.equal(await source.readTreeRef(testRef), baseline);
  await source.deleteTreeRef(testRef);
  assert.equal(await source.readTreeRef(testRef), null);
  writeFileSync(join(repo, "value.txt"), "after\n");
  writeFileSync(join(repo, "new.txt"), "new\n");
  writeFileSync(join(repo, "hidden.ignored"), "ignored\n");
  git(repo, "add", "value.txt");
  git(repo, "commit", "-qm", "agent commit");

  source.setTurnBaseline(baseline);
  source.setTurnTarget(await source.snapshotWorktree());
  source.setScope("last-turn");
  const model = await source.refresh(2);
  const paths = new Set(model.files.map((file) => file.path));

  assert.equal(paths.has("value.txt"), true);
  assert.equal(paths.has("new.txt"), true);
  assert.equal(paths.has("hidden.ignored"), false);
});

test("agent turn tracking persists and freezes an end-to-end last-turn diff", async () => {
  const repo = createRepo();
  writeFileSync(join(repo, "during.txt"), "before\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "base");

  const source = new GitSource(repo);
  const tracker = new AgentTurnTracker({
    source,
    agentPaneId: "w1:p1",
    reviewKey: "integration-turn",
  });
  const statuses = ["idle", "working", "working", "idle"];
  tracker.readStatus = async () => statuses.shift();
  await tracker.initialize();
  await tracker.sample();
  await tracker.sample();

  writeFileSync(join(repo, "during.txt"), "agent change\n");
  await tracker.sample();
  git(repo, "add", "during.txt");
  git(repo, "commit", "-qm", "agent commit");
  writeFileSync(join(repo, "ending.txt"), "final change\n");
  await tracker.sample();

  source.setScope("last-turn");
  const model = await source.refresh(1);
  const paths = new Set(model.files.map((file) => file.path));
  assert.equal(paths.has("during.txt"), true);
  assert.equal(paths.has("ending.txt"), true);

  writeFileSync(join(repo, "after.txt"), "human change after idle\n");
  const frozen = await source.refresh(2);
  assert.equal(
    frozen.files.some((file) => file.path === "after.txt"),
    false,
  );
});
