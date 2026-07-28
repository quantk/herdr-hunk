import { createRow, stableId } from "./model.mjs";

export function unquoteGitPath(value) {
  if (!value?.startsWith('"')) {
    return value;
  }
  const inner = value.slice(1, value.endsWith('"') ? -1 : undefined);
  const bytes = [];
  for (let index = 0; index < inner.length; index += 1) {
    const character = inner[index];
    if (character !== "\\") {
      const codePoint = inner.codePointAt(index);
      const decoded = String.fromCodePoint(codePoint);
      bytes.push(...Buffer.from(decoded));
      if (decoded.length === 2) index += 1;
      continue;
    }
    const remainder = inner.slice(index + 1);
    const octal = remainder.match(/^[0-7]{1,3}/)?.[0];
    if (octal) {
      bytes.push(Number.parseInt(octal, 8));
      index += octal.length;
      continue;
    }
    const escaped = inner[index + 1];
    const decoded = { t: "\t", n: "\n", r: "\r" }[escaped] ?? escaped;
    bytes.push(...Buffer.from(decoded));
    index += 1;
  }
  return Buffer.from(bytes).toString("utf8");
}

function splitDiffHeader(line) {
  const values = [];
  let cursor = "diff --git ".length;
  while (cursor < line.length && values.length < 2) {
    if (line[cursor] === '"') {
      let end = cursor + 1;
      while (end < line.length) {
        if (line[end] === '"' && line[end - 1] !== "\\") {
          break;
        }
        end += 1;
      }
      values.push(unquoteGitPath(line.slice(cursor, end + 1)));
      cursor = end + 1;
    } else {
      const end = line.indexOf(" ", cursor);
      values.push(line.slice(cursor, end === -1 ? undefined : end));
      cursor = end === -1 ? line.length : end;
    }
    while (line[cursor] === " ") cursor += 1;
  }
  return values.map((path) => path.replace(/^[ab]\//, ""));
}

function parseMarkerPath(line, prefix) {
  const raw = line.slice(prefix.length).split("\t", 1)[0];
  if (raw === "/dev/null") {
    return null;
  }
  return unquoteGitPath(raw).replace(/^[ab]\//, "");
}

function finalizeFile(file, generation) {
  if (!file) return undefined;
  file.path = file.path ?? file.previousPath ?? "(unknown)";
  file.previousPath =
    file.previousPath && file.previousPath !== file.path
      ? file.previousPath
      : null;
  file.id = stableId(file.previousPath ?? file.path, file.path);
  file.generation = generation;
  file.hunks.forEach((hunk, hunkIndex) => {
    hunk.order = hunkIndex;
    hunk.id = stableId(
      file.id,
      hunk.oldStart,
      hunk.oldCount,
      hunk.newStart,
      hunk.newCount,
      hunk.header,
    );
    const occurrences = new Map();
    hunk.rows = hunk.pendingRows.map((pending) => {
      const key = [
        pending.kind,
        pending.oldLine,
        pending.newLine,
        pending.text,
      ].join("\0");
      const occurrence = occurrences.get(key) ?? 0;
      occurrences.set(key, occurrence + 1);
      return createRow(
        file,
        hunk,
        pending.kind,
        pending.oldLine,
        pending.newLine,
        pending.text,
        occurrence,
      );
    });
    delete hunk.pendingRows;
  });
  file.rows = file.hunks.flatMap((hunk) => hunk.rows);
  if (file.kind === "text" && file.hunks.length === 0) {
    file.kind = file.modeChanged ? "mode" : "metadata";
  }
  return file;
}

export function parseUnifiedDiff(patch, { generation = 1 } = {}) {
  const files = [];
  let file;
  let hunk;
  let oldLine;
  let newLine;

  const finish = () => {
    const completed = finalizeFile(file, generation);
    if (completed) files.push(completed);
  };

  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      finish();
      const [previousPath, path] = splitDiffHeader(line);
      file = {
        id: "",
        path,
        previousPath,
        status: "modified",
        kind: "text",
        modeChanged: false,
        binary: false,
        tooLarge: false,
        hunks: [],
        rows: [],
        header: [line],
      };
      hunk = undefined;
      continue;
    }
    if (!file) continue;

    if (line.startsWith("new file mode ")) {
      file.status = "added";
      file.modeChanged = true;
      if (line.endsWith("160000")) file.kind = "submodule";
      file.header.push(line);
      continue;
    }
    if (line.startsWith("deleted file mode ")) {
      file.status = "deleted";
      file.modeChanged = true;
      if (line.endsWith("160000")) file.kind = "submodule";
      file.header.push(line);
      continue;
    }
    if (
      line.startsWith("old mode ") ||
      line.startsWith("new mode ")
    ) {
      file.modeChanged = true;
      file.header.push(line);
      continue;
    }
    if (/^index \S+\.\.\S+ 160000$/.test(line)) {
      file.kind = "submodule";
      file.header.push(line);
      continue;
    }
    if (line.startsWith("rename from ")) {
      file.status = "renamed";
      file.previousPath = unquoteGitPath(line.slice(12));
      file.header.push(line);
      continue;
    }
    if (line.startsWith("rename to ")) {
      file.status = "renamed";
      file.path = unquoteGitPath(line.slice(10));
      file.header.push(line);
      continue;
    }
    if (line.startsWith("Binary files ") || line === "GIT binary patch") {
      file.kind = "binary";
      file.binary = true;
      file.header.push(line);
      continue;
    }
    if (line.startsWith("Submodule ")) {
      file.kind = "submodule";
      file.header.push(line);
      continue;
    }
    if (line.startsWith("--- ")) {
      file.previousPath = parseMarkerPath(line, "--- ");
      file.header.push(line);
      continue;
    }
    if (line.startsWith("+++ ")) {
      file.path = parseMarkerPath(line, "+++ ");
      file.header.push(line);
      continue;
    }

    const match = line.match(
      /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/,
    );
    if (match) {
      oldLine = Number(match[1]);
      newLine = Number(match[3]);
      hunk = {
        id: "",
        header: match[5].trim(),
        oldStart: oldLine,
        oldCount: Number(match[2] ?? 1),
        newStart: newLine,
        newCount: Number(match[4] ?? 1),
        pendingRows: [],
      };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk) {
      if (line) file.header.push(line);
      continue;
    }

    if (line.startsWith("\\")) {
      hunk.pendingRows.push({
        kind: "no-newline",
        oldLine: null,
        newLine: null,
        text: line,
      });
    } else if (line.startsWith("+")) {
      if (line.startsWith("+Subproject commit ")) file.kind = "submodule";
      hunk.pendingRows.push({
        kind: "addition",
        oldLine: null,
        newLine,
        text: line.slice(1),
      });
      newLine += 1;
    } else if (line.startsWith("-")) {
      if (line.startsWith("-Subproject commit ")) file.kind = "submodule";
      hunk.pendingRows.push({
        kind: "deletion",
        oldLine,
        newLine: null,
        text: line.slice(1),
      });
      oldLine += 1;
    } else if (line.startsWith(" ")) {
      hunk.pendingRows.push({
        kind: "context",
        oldLine,
        newLine,
        text: line.slice(1),
      });
      oldLine += 1;
      newLine += 1;
    }
  }
  finish();
  return { generation, files };
}

export function createUntrackedPatch(path, content, mode = "100644") {
  const lines = content === "" ? [] : content.split("\n");
  const hasFinalNewline = content.endsWith("\n");
  if (hasFinalNewline && lines.length) lines.pop();
  const oldPath =
    path.includes(" ") || path.includes("\t") ? JSON.stringify(`a/${path}`) : `a/${path}`;
  const newPath =
    path.includes(" ") || path.includes("\t") ? JSON.stringify(`b/${path}`) : `b/${path}`;
  const body = lines.map((line) => `+${line}`).join("\n");
  const marker =
    hasFinalNewline || content === ""
      ? ""
      : "\n\\ No newline at end of file";
  return [
    `diff --git ${oldPath} ${newPath}`,
    `new file mode ${mode}`,
    "--- /dev/null",
    `+++ ${newPath}`,
    `@@ -0,0 +1,${lines.length} @@`,
    `${body}${marker}`,
  ].join("\n");
}
