import { createHash } from "node:crypto";

export const DIFF_LIMITS = Object.freeze({
  totalPatchBytes: 16 * 1024 * 1024,
  fileBytes: 2 * 1024 * 1024,
});

export function stableId(...parts) {
  return createHash("sha256")
    .update(parts.map((part) => String(part ?? "")).join("\0"))
    .digest("hex")
    .slice(0, 24);
}

export function createRow(file, hunk, kind, oldLine, newLine, text, occurrence) {
  return {
    id: stableId(
      file.id,
      hunk.id,
      kind,
      oldLine,
      newLine,
      text,
      occurrence,
    ),
    fileId: file.id,
    hunkId: hunk.id,
    kind,
    oldLine,
    newLine,
    text,
    occurrence,
    commentable: kind === "context" || kind === "addition" || kind === "deletion",
  };
}

export function findRow(model, rowId) {
  for (const file of model.files) {
    const row = file.rows.find((candidate) => candidate.id === rowId);
    if (row) {
      return { file, row };
    }
  }
  return undefined;
}

export function commentSide(row, preferredSide = "new") {
  if (row.kind === "deletion") {
    return "old";
  }
  if (row.kind === "addition") {
    return "new";
  }
  return preferredSide === "old" ? "old" : "new";
}

export function terminalSafeText(value) {
  return String(value).replace(
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,
    (character) =>
      character === "\u001b"
        ? "␛"
        : `\\x${character.charCodeAt(0).toString(16).padStart(2, "0")}`,
  );
}
