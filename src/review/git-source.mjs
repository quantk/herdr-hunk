import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  mkdtemp,
  open,
  readlink,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { DIFF_LIMITS } from "./model.mjs";
import { createUntrackedPatch, parseUnifiedDiff } from "./parse-diff.mjs";
import { normalizeScope, scopeLabel } from "./scopes.mjs";

const execFileAsync = promisify(execFile);
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const GIT_ENV = {
  ...process.env,
  GIT_OPTIONAL_LOCKS: "0",
  GIT_PAGER: "cat",
  GIT_EXTERNAL_DIFF: "",
};

async function git(repo, args, options = {}) {
  const result = await execFileAsync(
    "git",
    ["-C", repo, "-c", "core.pager=cat", "-c", "color.ui=false", ...args],
    {
      encoding: options.encoding ?? "utf8",
      env: { ...GIT_ENV, ...options.env },
      maxBuffer: options.maxBuffer ?? 32 * 1024 * 1024,
      timeout: options.timeout ?? 30_000,
    },
  );
  return result.stdout;
}

function parseDiffNameStatus(buffer) {
  const entries = [];
  const tokens = buffer.toString("utf8").split("\0");
  let index = 0;
  while (index < tokens.length) {
    const status = tokens[index++];
    if (!status) continue;
    if (status.startsWith("R") || status.startsWith("C")) {
      const previousPath = tokens[index++];
      const path = tokens[index++];
      if (path) entries.push({ status, path, previousPath });
    } else {
      const path = tokens[index++];
      if (path) entries.push({ status, path, previousPath: null });
    }
  }
  return entries;
}

export function parsePorcelainStatus(buffer) {
  const entries = [];
  const tokens = buffer.toString("utf8").split("\0");
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    if (token.startsWith("?? ")) {
      entries.push({ status: "untracked", path: token.slice(3) });
      continue;
    }
    if (token.startsWith("!! ")) continue;
    const code = token.slice(0, 2);
    let path = token.slice(3);
    let previousPath = null;
    if (code.includes("R") || code.includes("C")) {
      previousPath = tokens[index + 1] || null;
      index += 1;
    }
    entries.push({ status: code, path, previousPath });
  }
  return entries;
}

function normalizedStatus(entry) {
  if (entry.status === "untracked" || entry.status.includes("A")) return "added";
  if (entry.status.includes("D")) return "deleted";
  if (entry.status.includes("R")) return "renamed";
  return "modified";
}

function isUtf8Text(content) {
  if (content.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(content);
    return true;
  } catch {
    return false;
  }
}

async function readRegularFileLimited(path, maxBytes) {
  let handle;
  try {
    handle = await open(
      path,
      fsConstants.O_RDONLY |
        (fsConstants.O_NOFOLLOW ?? 0) |
        (fsConstants.O_NONBLOCK ?? 0),
    );
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ELOOP") return undefined;
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return undefined;
    if (info.size > maxBytes) {
      return { tooLarge: true, mode: info.mode };
    }
    const chunks = [];
    let position = 0;
    while (position <= maxBytes) {
      const size = Math.min(64 * 1024, maxBytes + 1 - position);
      const chunk = Buffer.allocUnsafe(size);
      const { bytesRead } = await handle.read(
        chunk,
        0,
        size,
        position,
      );
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      position += bytesRead;
    }
    if (position > maxBytes) {
      return { tooLarge: true, mode: info.mode };
    }
    return {
      tooLarge: false,
      mode: info.mode,
      content: Buffer.concat(chunks, position),
    };
  } finally {
    await handle.close();
  }
}

export class GitSource {
  constructor(repo, limits = DIFF_LIMITS) {
    this.repo = repo;
    this.limits = limits;
    this.scope = "uncommitted";
    this.turnBaseline = null;
    this.turnTarget = null;
    this.turnTrackingError = null;
    this.branchBase = null;
    this.branchBaseLabel = null;
  }

  setScope(scope) {
    this.scope = normalizeScope(scope);
  }

  setTurnBaseline(tree) {
    this.turnBaseline = tree || null;
  }

  setTurnTarget(tree) {
    this.turnTarget = tree || null;
  }

  setTurnTrackingError(error) {
    this.turnTrackingError = error || null;
  }

  describeScope() {
    if (this.scope === "branch") {
      return this.branchBaseLabel
        ? `2 branch · ${this.branchBaseLabel}`
        : "2 branch";
    }
    if (this.scope === "last-turn") {
      return this.turnBaseline && this.turnTarget
        ? "3 last observed turn"
        : "3 last turn · waiting";
    }
    return "1 working tree";
  }

  scopeIdentity() {
    return this.scope === "last-turn" ? this.turnBaseline : null;
  }

  async resolveBranchBase() {
    let originHead;
    try {
      originHead = (
        await git(this.repo, [
          "symbolic-ref",
          "--quiet",
          "--short",
          "refs/remotes/origin/HEAD",
        ])
      ).trim();
    } catch {
      originHead = null;
    }
    const candidates = [
      originHead,
      "origin/main",
      "main",
      "origin/master",
      "master",
    ].filter(Boolean);
    for (const candidate of candidates) {
      try {
        await git(this.repo, [
          "rev-parse",
          "--verify",
          `${candidate}^{commit}`,
        ]);
        const mergeBase = (
          await git(this.repo, ["merge-base", candidate, "HEAD"])
        ).trim();
        if (mergeBase) {
          this.branchBase = mergeBase;
          this.branchBaseLabel = candidate;
          return mergeBase;
        }
      } catch {
        // Try the next local base candidate.
      }
    }
    this.branchBase = null;
    this.branchBaseLabel = null;
    throw new Error(
      "No local base branch was found (tried origin/HEAD, main, and master).",
    );
  }

  async snapshotWorktree() {
    const directory = await mkdtemp(join(tmpdir(), "herdr-hunk-index-"));
    const indexPath = join(directory, "index");
    const env = { GIT_INDEX_FILE: indexPath };
    try {
      try {
        await git(this.repo, ["read-tree", "HEAD"], { env });
      } catch {
        await git(this.repo, ["read-tree", "--empty"], { env });
      }
      await git(this.repo, ["add", "-A", "--", "."], { env });
      return (await git(this.repo, ["write-tree"], { env })).trim();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async readTreeRef(ref) {
    try {
      return (
        await git(this.repo, ["rev-parse", "--verify", `${ref}^{tree}`])
      ).trim();
    } catch {
      return null;
    }
  }

  async writeTreeRef(ref, tree) {
    await git(this.repo, ["update-ref", ref, tree]);
  }

  async deleteTreeRef(ref) {
    try {
      await git(this.repo, ["update-ref", "-d", ref]);
    } catch {
      // Deleting an absent candidate is already the desired state.
    }
  }

  async comparison() {
    if (this.scope === "last-turn") {
      if (!this.turnBaseline || !this.turnTarget) {
        return { base: null, target: null, entries: [], waiting: true };
      }
      const stdout = await git(
        this.repo,
        [
          "diff",
          "--name-status",
          "-z",
          "--find-renames=50%",
          this.turnBaseline,
          this.turnTarget,
          "--",
        ],
        { encoding: "buffer", maxBuffer: this.limits.totalPatchBytes },
      );
      return {
        base: this.turnBaseline,
        target: this.turnTarget,
        entries: parseDiffNameStatus(stdout),
      };
    }

    if (this.scope === "branch") {
      const base = await this.resolveBranchBase();
      const stdout = await git(
        this.repo,
        [
          "diff",
          "--name-status",
          "-z",
          "--find-renames=50%",
          base,
          "--",
        ],
        { encoding: "buffer", maxBuffer: this.limits.totalPatchBytes },
      );
      const tracked = parseDiffNameStatus(stdout);
      const porcelain = await this.porcelain();
      return {
        base,
        target: null,
        entries: [
          ...tracked,
          ...porcelain.entries.filter((entry) => entry.status === "untracked"),
        ],
        statusBuffer: porcelain.buffer,
      };
    }

    const porcelain = await this.porcelain();
    let base = "HEAD";
    try {
      await git(this.repo, ["rev-parse", "--verify", "HEAD"]);
    } catch {
      base = EMPTY_TREE;
    }
    return {
      base,
      target: null,
      entries: porcelain.entries,
      statusBuffer: porcelain.buffer,
    };
  }

  async porcelain() {
    const stdout = await git(
      this.repo,
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      { encoding: "buffer", maxBuffer: this.limits.totalPatchBytes },
    );
    const buffer = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
    return { buffer, entries: parsePorcelainStatus(buffer) };
  }

  async workingStateFingerprint() {
    const { buffer, entries } = await this.porcelain();
    const fingerprint = createHash("sha256");
    fingerprint.update(buffer);
    for (const entry of entries) {
      fingerprint.update(`\0${entry.path}\0`);
      try {
        const info = await lstat(resolve(this.repo, entry.path), {
          bigint: true,
        });
        fingerprint.update(
          `${info.size}:${info.mtimeNs}:${info.mode}:${info.ino}`,
        );
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        fingerprint.update("deleted");
      }
    }
    try {
      const indexPath = (
        await git(this.repo, ["rev-parse", "--git-path", "index"])
      ).trim();
      const index = await lstat(resolve(this.repo, indexPath), {
        bigint: true,
      });
      fingerprint.update(
        `\0index:${index.size}:${index.mtimeNs}:${index.ino}`,
      );
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    try {
      fingerprint.update(
        `\0head:${(await git(this.repo, ["rev-parse", "--verify", "HEAD"])).trim()}`,
      );
    } catch {
      fingerprint.update("\0head:unborn");
    }
    return fingerprint.digest("hex");
  }

  async status() {
    const comparison = await this.comparison();
    const buffer = comparison.statusBuffer ?? Buffer.alloc(0);
    const entries = comparison.entries;
    const fingerprint = createHash("sha256");
    fingerprint.update(`${this.scope}\0${comparison.base ?? "none"}\0`);
    fingerprint.update(`${comparison.target ?? "worktree"}\0`);
    fingerprint.update(buffer);
    if (this.scope !== "last-turn") {
      for (const entry of entries) {
        fingerprint.update(`\0${entry.path}\0`);
        try {
          const info = await lstat(resolve(this.repo, entry.path), {
            bigint: true,
          });
          fingerprint.update(
            `${info.size}:${info.mtimeNs}:${info.mode}:${info.ino}`,
          );
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
          fingerprint.update("deleted");
        }
      }
      try {
        const indexPath = (
          await git(this.repo, ["rev-parse", "--git-path", "index"])
        ).trim();
        const index = await lstat(resolve(this.repo, indexPath), {
          bigint: true,
        });
        fingerprint.update(
          `\0index:${index.size}:${index.mtimeNs}:${index.ino}`,
        );
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      try {
        fingerprint.update(
          `\0head:${(await git(this.repo, ["rev-parse", "--verify", "HEAD"])).trim()}`,
        );
      } catch {
        fingerprint.update("\0head:unborn");
      }
    }
    return {
      fingerprint: fingerprint.digest("hex"),
      entries,
      comparison,
    };
  }

  async refresh(generation = 1, knownStatus) {
    const status = knownStatus ?? await this.status();
    const comparison = status.comparison ?? await this.comparison();
    const { base, target } = comparison;

    let patch = "";
    const oversized = [];
    const trackedEntries = status.entries.filter(
      (candidate) => candidate.status !== "untracked",
    );
    for (const entry of trackedEntries) {
      let filePatch;
      try {
        filePatch = await git(
          this.repo,
          [
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--find-renames=50%",
            "--src-prefix=a/",
            "--dst-prefix=b/",
            base,
            ...(target ? [target] : []),
            "--",
            ...[entry.path, entry.previousPath].filter(Boolean),
          ],
          { maxBuffer: this.limits.fileBytes + 1024 },
        );
      } catch (error) {
        if (error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          oversized.push({
            ...entry,
            reason: `file exceeds ${this.limits.fileBytes} bytes`,
          });
          continue;
        }
        throw error;
      }
      if (
        Buffer.byteLength(filePatch) > this.limits.fileBytes ||
        Buffer.byteLength(patch) + Buffer.byteLength(filePatch) >
          this.limits.totalPatchBytes
      ) {
        oversized.push({
          ...entry,
          reason:
            Buffer.byteLength(filePatch) > this.limits.fileBytes
              ? `file exceeds ${this.limits.fileBytes} bytes`
              : `total patch exceeds ${this.limits.totalPatchBytes} bytes`,
        });
      } else {
        patch += filePatch;
      }
    }

    for (const entry of status.entries.filter(
      (candidate) => candidate.status === "untracked",
    )) {
      const absolutePath = resolve(this.repo, entry.path);
      let info;
      try {
        info = await lstat(absolutePath);
      } catch (error) {
        if (error?.code === "ENOENT") continue;
        throw error;
      }
      if (info.isSymbolicLink()) {
        let target;
        try {
          target = await readlink(absolutePath);
        } catch (error) {
          if (error?.code === "ENOENT" || error?.code === "EINVAL") continue;
          throw error;
        }
        const linkPatch = createUntrackedPatch(entry.path, target, "120000");
        if (
          Buffer.byteLength(patch) + Buffer.byteLength(linkPatch) <=
          this.limits.totalPatchBytes
        ) {
          patch += `\n${linkPatch}\n`;
        } else {
          oversized.push({
            ...entry,
            reason: `total patch exceeds ${this.limits.totalPatchBytes} bytes`,
          });
        }
        continue;
      }
      if (!info.isFile()) continue;
      const opened = await readRegularFileLimited(
        absolutePath,
        this.limits.fileBytes,
      );
      if (!opened) continue;
      if (opened.tooLarge) {
        oversized.push({
          ...entry,
          reason: `file exceeds ${this.limits.fileBytes} bytes`,
        });
        continue;
      }
      const content = opened.content;
      if (!isUtf8Text(content)) {
        const binaryPatch = [
          "",
          `diff --git a/${entry.path} b/${entry.path}`,
          "new file mode 100644",
          `Binary files /dev/null and b/${entry.path} differ`,
          "",
        ].join("\n");
        if (
          Buffer.byteLength(patch) + Buffer.byteLength(binaryPatch) <=
          this.limits.totalPatchBytes
        ) {
          patch += binaryPatch;
        } else {
          oversized.push({
            ...entry,
            reason: `total patch exceeds ${this.limits.totalPatchBytes} bytes`,
          });
        }
      } else {
        const textPatch = createUntrackedPatch(
          entry.path,
          content.toString("utf8"),
          opened.mode & 0o111 ? "100755" : "100644",
        );
        if (
          Buffer.byteLength(patch) + Buffer.byteLength(textPatch) <=
          this.limits.totalPatchBytes
        ) {
          patch += `\n${textPatch}\n`;
        } else {
          oversized.push({
            ...entry,
            reason: `total patch exceeds ${this.limits.totalPatchBytes} bytes`,
          });
        }
      }
    }

    const model = parseUnifiedDiff(patch, { generation });
    for (const entry of oversized) {
      model.files.push({
        id: `large:${entry.previousPath ?? ""}:${entry.path}`,
        path: entry.path,
        previousPath: entry.previousPath,
        status: normalizedStatus(entry),
        kind: "too-large",
        modeChanged: false,
        binary: false,
        tooLarge: true,
        generation,
        hunks: [],
        rows: [],
        header: [`Diff skipped: ${entry.reason}.`],
      });
    }
    return {
      ...model,
      fingerprint: status.fingerprint,
      scope: this.scope,
      scopeBase: base,
      scopeTarget: target,
      waiting: Boolean(comparison.waiting),
    };
  }
}
