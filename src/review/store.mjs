import { randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { relative, resolve } from "node:path";
import {
  getSnapshotPath,
  userNotesFromReview,
  unwrapHunkReviewResponse,
  writeJsonAtomic,
} from "../common.mjs";
import { contextHash, reanchorNotes } from "./anchors.mjs";
import { normalizeScope, REVIEW_SCOPES } from "./scopes.mjs";

export const STORE_VERSION = 3;
export const MAX_NOTE_BYTES = 64 * 1024;
export const MAX_NOTES = 500;

function assert(condition, message) {
  if (!condition) throw new Error(`Invalid review store: ${message}`);
}

function validRelativePath(path, repository) {
  if (typeof path !== "string" || path.length === 0 || path.includes("\0")) {
    return false;
  }
  const target = resolve(repository, path);
  const relation = relative(repository, target);
  return relation !== ".." && !relation.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`);
}

export function validateNote(note, repository) {
  assert(note && typeof note === "object", "note must be an object");
  assert(typeof note.id === "string" && note.id.length > 0, "note ID is required");
  assert(note.provenance === "human", "note provenance must be human");
  assert(typeof note.body === "string" && note.body.trim(), "note body is empty");
  assert(typeof note.title === "string", "note title must be a string");
  assert(
    note.resolvedAt == null ||
      (typeof note.resolvedAt === "string" &&
        Number.isFinite(Date.parse(note.resolvedAt))),
    "invalid resolved timestamp",
  );
  assert(REVIEW_SCOPES.includes(note.scope), "invalid note scope");
  assert(
    note.scopeBase == null || typeof note.scopeBase === "string",
    "invalid note scope base",
  );
  assert(
    Buffer.byteLength(note.body, "utf8") <= MAX_NOTE_BYTES,
    `note exceeds ${MAX_NOTE_BYTES} bytes`,
  );
  assert(
    note.status === "anchored" || note.status === "stale",
    "note status must be anchored or stale",
  );
  const anchor = note.anchor;
  assert(anchor && typeof anchor === "object", "note anchor is required");
  assert(validRelativePath(anchor.path, repository), "note path escapes repository");
  assert(
    anchor.previousPath == null || validRelativePath(anchor.previousPath, repository),
    "previous note path escapes repository",
  );
  assert(anchor.side === "old" || anchor.side === "new", "invalid note side");
  assert(Number.isInteger(anchor.startLine) && anchor.startLine >= 1, "invalid start line");
  assert(
    Number.isInteger(anchor.endLine) && anchor.endLine >= anchor.startLine,
    "invalid end line",
  );
  assert(
    Array.isArray(anchor.selectedText) &&
      anchor.selectedText.length === anchor.endLine - anchor.startLine + 1 &&
      anchor.selectedText.every((line) => typeof line === "string"),
    "selected text does not match the line range",
  );
  assert(
    Array.isArray(anchor.contextBefore) &&
      anchor.contextBefore.every((line) => typeof line === "string") &&
      Array.isArray(anchor.contextAfter) &&
      anchor.contextAfter.every((line) => typeof line === "string"),
    "invalid anchor context",
  );
  assert(typeof anchor.contextHash === "string" && anchor.contextHash, "context hash is required");
  assert(
    anchor.contextHash ===
      contextHash(
        anchor.selectedText,
        anchor.contextBefore,
        anchor.contextAfter,
      ),
    "context hash does not match anchor content",
  );
  assert(Number.isInteger(anchor.diffGeneration) && anchor.diffGeneration >= 0, "invalid diff generation");
  assert(Number.isFinite(Date.parse(note.createdAt)), "invalid created timestamp");
  assert(Number.isFinite(Date.parse(note.updatedAt)), "invalid updated timestamp");
  return note;
}

export function validateStore(document, reviewKey, repository) {
  assert(document?.version === STORE_VERSION, `expected version ${STORE_VERSION}`);
  assert(document.reviewKey === reviewKey, "review key does not match association");
  assert(document.repository === repository, "repository does not match association");
  assert(resolve(repository) === repository, "repository must be absolute");
  assert(Number.isFinite(Date.parse(document.updatedAt)), "invalid store timestamp");
  assert(document.ui && typeof document.ui === "object", "UI state is required");
  assert(
    document.ui.filePath == null ||
      validRelativePath(document.ui.filePath, repository),
    "UI path escapes repository",
  );
  assert(
    document.ui.rowId == null || typeof document.ui.rowId === "string",
    "invalid UI row ID",
  );
  assert(
    document.ui.sidebarVisible == null ||
      typeof document.ui.sidebarVisible === "boolean",
    "invalid sidebar visibility",
  );
  assert(
    document.ui.sidebarWidth == null ||
      (Number.isInteger(document.ui.sidebarWidth) &&
        document.ui.sidebarWidth >= 18 &&
        document.ui.sidebarWidth <= 80),
    "invalid sidebar width",
  );
  assert(
    document.ui.rowWrap == null || typeof document.ui.rowWrap === "boolean",
    "invalid row-wrap state",
  );
  assert(REVIEW_SCOPES.includes(document.ui.scope), "invalid review scope");
  assert(
    document.ui.scopeBase == null ||
      typeof document.ui.scopeBase === "string",
    "invalid UI scope base",
  );
  assert(Array.isArray(document.notes), "notes must be an array");
  assert(document.notes.length <= MAX_NOTES, `too many notes (limit ${MAX_NOTES})`);
  const ids = new Set();
  for (const note of document.notes) {
    validateNote(note, repository);
    assert(!ids.has(note.id), "duplicate note ID");
    ids.add(note.id);
  }
  return document;
}

export function emptyStore(reviewKey, repository) {
  return {
    version: STORE_VERSION,
    reviewKey,
    repository,
    updatedAt: new Date(0).toISOString(),
    ui: {
      filePath: null,
      rowId: null,
      sidebarVisible: null,
      sidebarWidth: null,
      rowWrap: false,
      scope: "uncommitted",
      scopeBase: null,
    },
    notes: [],
  };
}

export function writeStoreAtomic(path, document) {
  writeJsonAtomic(path, document);
}

function legacyAnchor(note) {
  const newRange = Array.isArray(note.newRange) ? note.newRange : null;
  const oldRange = Array.isArray(note.oldRange) ? note.oldRange : null;
  const range = newRange ?? oldRange;
  const selectedText = Array.isArray(note.selectedText)
    ? note.selectedText.map(String)
    : [typeof note.line === "string" ? note.line : "(legacy location unavailable)"];
  const startLine = Number.isInteger(range?.[0]) ? Math.max(1, range[0]) : 1;
  const endLine = Number.isInteger(range?.[1])
    ? Math.max(startLine, range[1])
    : startLine + selectedText.length - 1;
  while (selectedText.length < endLine - startLine + 1) selectedText.push("");
  const contextBefore = Array.isArray(note.contextBefore) ? note.contextBefore.map(String) : [];
  const contextAfter = Array.isArray(note.contextAfter) ? note.contextAfter.map(String) : [];
  return {
    path: note.filePath || "(unknown)",
    previousPath: null,
    side: newRange ? "new" : "old",
    startLine,
    endLine,
    selectedText,
    contextBefore,
    contextAfter,
    contextHash: contextHash(selectedText, contextBefore, contextAfter),
    diffGeneration: 0,
  };
}

export function migrateLegacyStore(legacy, reviewKey, repository, model) {
  const review = unwrapHunkReviewResponse(legacy.review ?? legacy);
  const now = new Date().toISOString();
  const notes = userNotesFromReview(review).map((note) => ({
    id: randomUUID(),
    provenance: "human",
    title: typeof note.title === "string" ? note.title : "",
    body: note.body,
    resolvedAt: null,
    scope: "uncommitted",
    scopeBase: null,
    anchor: legacyAnchor(note),
    status: "stale",
    createdAt: now,
    updatedAt: now,
  }));
  const anchored = model ? reanchorNotes(notes, model) : notes;
  return validateStore(
    {
      version: STORE_VERSION,
      reviewKey,
      repository,
      updatedAt: now,
      ui: {
        filePath: null,
        rowId: null,
        sidebarVisible: null,
        sidebarWidth: null,
        rowWrap: false,
        scope: "uncommitted",
        scopeBase: null,
      },
      notes: anchored,
    },
    reviewKey,
    repository,
  );
}

export function readStore(stateDir, reviewKey, repository, { model } = {}) {
  const path = getSnapshotPath(stateDir, reviewKey);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return emptyStore(reviewKey, repository);
    throw new Error(`Cannot read saved review: ${error.message}`);
  }
  if (parsed?.version === STORE_VERSION) {
    return validateStore(parsed, reviewKey, repository);
  }

  const migrated =
    parsed?.version === 2
      ? validateStore(
          {
            ...parsed,
            version: STORE_VERSION,
            ui: {
              ...parsed.ui,
              scope: normalizeScope(parsed.ui?.scope),
              scopeBase: null,
            },
            notes: Array.isArray(parsed.notes)
              ? parsed.notes.map((note) => ({
                  ...note,
                  resolvedAt: null,
                  scope: normalizeScope(note.scope),
                  scopeBase: null,
                }))
              : [],
          },
          reviewKey,
          repository,
        )
      : migrateLegacyStore(parsed, reviewKey, repository, model);
  const backup = `${path}.v${parsed?.version === 2 ? 2 : 1}.bak`;
  if (!existsSync(backup)) {
    copyFileSync(path, backup);
    chmodSync(backup, 0o600);
  }
  writeStoreAtomic(path, migrated);
  validateStore(JSON.parse(readFileSync(path, "utf8")), reviewKey, repository);
  return migrated;
}

export function saveStore(stateDir, document) {
  validateStore(document, document.reviewKey, document.repository);
  const updated = { ...document, updatedAt: new Date().toISOString() };
  writeStoreAtomic(
    getSnapshotPath(stateDir, document.reviewKey),
    updated,
  );
  return updated;
}

export function createHumanNote(
  body,
  anchor,
  title = "",
  scope = "uncommitted",
  scopeBase = null,
) {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    provenance: "human",
    title,
    body,
    resolvedAt: null,
    scope: normalizeScope(scope),
    scopeBase:
      normalizeScope(scope) === "last-turn" ? scopeBase : null,
    anchor,
    status: "anchored",
    createdAt: now,
    updatedAt: now,
  };
}
