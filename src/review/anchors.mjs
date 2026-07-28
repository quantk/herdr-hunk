import { createHash } from "node:crypto";
import { commentSide } from "./model.mjs";

export function contextHash(selectedText, contextBefore, contextAfter) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        selectedText,
        contextBefore,
        contextAfter,
      }),
    )
    .digest("hex");
}

function sideLine(row, side) {
  return side === "old" ? row.oldLine : row.newLine;
}

export function createAnchor(file, rows, generation, preferredSide = "new") {
  const selected = rows.filter((row) => row.commentable);
  if (selected.length === 0) {
    throw new Error("Select at least one commentable diff line.");
  }
  const side = commentSide(selected[0], preferredSide);
  if (selected.some((row) => sideLine(row, side) == null)) {
    throw new Error("A comment range cannot cross old and new diff sides.");
  }
  const indices = selected.map((row) => file.rows.indexOf(row));
  const first = Math.min(...indices);
  const last = Math.max(...indices);
  const selectedText = selected.map((row) => row.text);
  const contextBefore = file.rows
    .slice(Math.max(0, first - 2), first)
    .filter((row) => sideLine(row, side) != null)
    .map((row) => row.text);
  const contextAfter = file.rows
    .slice(last + 1, last + 3)
    .filter((row) => sideLine(row, side) != null)
    .map((row) => row.text);
  return {
    path: file.path,
    previousPath: file.previousPath,
    side,
    startLine: sideLine(selected[0], side),
    endLine: sideLine(selected.at(-1), side),
    selectedText,
    contextBefore,
    contextAfter,
    contextHash: contextHash(selectedText, contextBefore, contextAfter),
    diffGeneration: generation,
  };
}

function candidateRanges(file, side, count) {
  const rows = file.rows.filter((row) => sideLine(row, side) != null);
  const ranges = [];
  for (let index = 0; index <= rows.length - count; index += 1) {
    const slice = rows.slice(index, index + count);
    const lines = slice.map((row) => sideLine(row, side));
    if (lines.every((line, offset) => line === lines[0] + offset)) {
      ranges.push(slice);
    }
  }
  return ranges;
}

function anchorForRange(file, rows, oldAnchor, generation) {
  const first = file.rows.indexOf(rows[0]);
  const last = file.rows.indexOf(rows.at(-1));
  const before = file.rows
    .slice(Math.max(0, first - 2), first)
    .filter((row) => sideLine(row, oldAnchor.side) != null)
    .map((row) => row.text);
  const after = file.rows
    .slice(last + 1, last + 3)
    .filter((row) => sideLine(row, oldAnchor.side) != null)
    .map((row) => row.text);
  return {
    ...oldAnchor,
    path: file.path,
    previousPath: file.previousPath,
    startLine: sideLine(rows[0], oldAnchor.side),
    endLine: sideLine(rows.at(-1), oldAnchor.side),
    contextBefore: before,
    contextAfter: after,
    contextHash: contextHash(oldAnchor.selectedText, before, after),
    diffGeneration: generation,
  };
}

export function reanchorNote(note, model) {
  const paths = new Set([note.anchor.path, note.anchor.previousPath].filter(Boolean));
  const files = model.files.filter(
    (file) =>
      paths.has(file.path) ||
      paths.has(file.previousPath),
  );
  const matches = [];
  for (const file of files) {
    for (const rows of candidateRanges(
      file,
      note.anchor.side,
      note.anchor.selectedText.length,
    )) {
      const text = rows.map((row) => row.text);
      if (JSON.stringify(text) !== JSON.stringify(note.anchor.selectedText)) {
        continue;
      }
      const exactLine =
        sideLine(rows[0], note.anchor.side) === note.anchor.startLine &&
        sideLine(rows.at(-1), note.anchor.side) === note.anchor.endLine;
      const first = file.rows.indexOf(rows[0]);
      const last = file.rows.indexOf(rows.at(-1));
      const before = file.rows
        .slice(Math.max(0, first - 2), first)
        .filter((row) => sideLine(row, note.anchor.side) != null)
        .map((row) => row.text);
      const after = file.rows
        .slice(last + 1, last + 3)
        .filter((row) => sideLine(row, note.anchor.side) != null)
        .map((row) => row.text);
      const exactContext =
        contextHash(text, before, after) === note.anchor.contextHash;
      matches.push({ file, rows, exactLine, exactContext });
    }
  }
  const preferred =
    matches.filter((match) => match.exactLine && match.exactContext) ||
    [];
  const contextMatches = matches.filter((match) => match.exactContext);
  const selected =
    preferred.length === 1
      ? preferred[0]
      : contextMatches.length === 1
        ? contextMatches[0]
        : matches.length === 1
          ? matches[0]
          : undefined;
  if (!selected) {
    return { ...note, status: "stale" };
  }
  return {
    ...note,
    status: "anchored",
    anchor: anchorForRange(
      selected.file,
      selected.rows,
      note.anchor,
      model.generation,
    ),
  };
}

export function reanchorNotes(notes, model) {
  return notes.map((note) => reanchorNote(note, model));
}
