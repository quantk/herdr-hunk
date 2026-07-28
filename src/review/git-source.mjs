import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readlink } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { DIFF_LIMITS } from "./model.mjs";
import { createUntrackedPatch, parseUnifiedDiff } from "./parse-diff.mjs";

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
      env: GIT_ENV,
      maxBuffer: options.maxBuffer ?? 32 * 1024 * 1024,
    },
  );
  return result.stdout;
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

export class GitSource {
  constructor(repo, limits = DIFF_LIMITS) {
    this.repo = repo;
    this.limits = limits;
  }

  async status() {
    const stdout = await git(
      this.repo,
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      { encoding: "buffer", maxBuffer: this.limits.totalPatchBytes },
    );
    const buffer = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
    const entries = parsePorcelainStatus(buffer);
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
    return {
      fingerprint: fingerprint.digest("hex"),
      entries,
    };
  }

  async refresh(generation = 1, knownStatus) {
    const status = knownStatus ?? await this.status();
    let base = "HEAD";
    try {
      await git(this.repo, ["rev-parse", "--verify", "HEAD"]);
    } catch {
      base = EMPTY_TREE;
    }

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
      const info = await lstat(absolutePath);
      if (info.isSymbolicLink()) {
        const linkPatch = createUntrackedPatch(
          entry.path,
          await readlink(absolutePath),
          "120000",
        );
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
      if (info.size > this.limits.fileBytes) {
        oversized.push({
          ...entry,
          reason: `file exceeds ${this.limits.fileBytes} bytes`,
        });
        continue;
      }
      const content = await readFile(absolutePath);
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
          info.mode & 0o111 ? "100755" : "100644",
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
    return { ...model, fingerprint: status.fingerprint };
  }
}
