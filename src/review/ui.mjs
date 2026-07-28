import {
  BoxRenderable,
  CliRenderEvents,
  ScrollBoxRenderable,
  TextareaRenderable,
  TextRenderable,
} from "@opentui/core";
import { detectFiletype } from "./languages.mjs";
import { commentSide, terminalSafeText } from "./model.mjs";
import { scopeLabel } from "./scopes.mjs";
import { shortcutName } from "./shortcuts.mjs";

const COLORS = {
  selected: "#30384a",
  addition: "#98c379",
  additionBackground: "#173c2a",
  selectedAdditionBackground: "#28513b",
  deletion: "#e06c75",
  deletionBackground: "#44242a",
  selectedDeletionBackground: "#5a3038",
  context: "#abb2bf",
  muted: "#7f848e",
  warning: "#e5c07b",
  accent: "#61afef",
};
const MIN_SIDEBAR_WIDTH = 18;
const MAX_SIDEBAR_WIDTH = 80;
const MIN_DIFF_WIDTH = 32;

function clear(renderable) {
  for (const child of [...renderable.getChildren()]) {
    renderable.remove(child);
    child.destroyRecursively();
  }
}

function text(ctx, id, content, options = {}) {
  return new TextRenderable(ctx, {
    id,
    content,
    height: 1,
    wrapMode: "none",
    ...options,
  });
}

function rowPrefix(row) {
  const old = row.oldLine == null ? "    " : String(row.oldLine).padStart(4);
  const next = row.newLine == null ? "    " : String(row.newLine).padStart(4);
  const marker =
    row.kind === "addition" ? "+" : row.kind === "deletion" ? "-" : " ";
  return `${old} ${next} ${marker} `;
}

function noteAtRow(controller) {
  const row = controller.row;
  const file = controller.file;
  if (!row || !file) return undefined;
  const matching = controller.notes.filter((note) => {
    if (
      note.status !== "anchored" ||
      (note.anchor.path !== file.path &&
        note.anchor.path !== file.previousPath)
    ) {
      return false;
    }
    const line =
      note.anchor.side === "old" ? row.oldLine : row.newLine;
    return (
      line != null &&
      line >= note.anchor.startLine &&
      line <= note.anchor.endLine
    );
  });
  return matching.find((note) => note.resolvedAt == null) ?? matching[0];
}

function notesEndingAtRow(controller, file, row) {
  return controller.notes.filter((note) => {
    if (
      note.status !== "anchored" ||
      (note.anchor.path !== file.path &&
        note.anchor.path !== file.previousPath)
    ) {
      return false;
    }
    const line = note.anchor.side === "old" ? row.oldLine : row.newLine;
    return line === note.anchor.endLine;
  });
}

function detachedPlacements(controller, file) {
  const byEndRow = new Map();
  const placedIds = new Set();
  const filePaths = new Set([file.path, file.previousPath].filter(Boolean));

  for (const note of controller.detachedOpenNotes) {
    const notePaths = [note.anchor.path, note.anchor.previousPath].filter(Boolean);
    if (!notePaths.some((path) => filePaths.has(path))) continue;
    const selectedText = note.anchor.selectedText;
    if (!Array.isArray(selectedText) || selectedText.length === 0) continue;

    const matches = new Map();
    for (const side of ["old", "new"]) {
      const rows = file.rows.filter((row) =>
        Number.isInteger(side === "old" ? row.oldLine : row.newLine)
      );
      for (let index = 0; index <= rows.length - selectedText.length; index += 1) {
        const candidate = rows.slice(index, index + selectedText.length);
        const lines = candidate.map((row) =>
          side === "old" ? row.oldLine : row.newLine
        );
        if (!lines.every((line, offset) => line === lines[0] + offset)) continue;
        if (!candidate.every((row, offset) => row.text === selectedText[offset])) {
          continue;
        }
        const key = candidate.map((row) => row.id).join("\0");
        matches.set(key, candidate);
      }
    }

    if (matches.size !== 1) continue;
    const rows = [...matches.values()][0];
    const endRow = rows.at(-1);
    const notes = byEndRow.get(endRow.id) ?? [];
    notes.push(note);
    byEndRow.set(endRow.id, notes);
    placedIds.add(note.id);
  }

  return { byEndRow, placedIds };
}

function commentTarget(controller) {
  const row = controller.row;
  if (!row?.commentable) return "target:none";
  const side = commentSide(row, controller.preferredSide);
  const line = side === "old" ? row.oldLine : row.newLine;
  return `target:${side}:${line}`;
}

function rowBackground(row, selected) {
  if (row.kind === "addition") {
    return selected
      ? COLORS.selectedAdditionBackground
      : COLORS.additionBackground;
  }
  if (row.kind === "deletion") {
    return selected
      ? COLORS.selectedDeletionBackground
      : COLORS.deletionBackground;
  }
  return selected ? COLORS.selected : undefined;
}

export class ReviewUI {
  constructor(renderer, controller, highlighter) {
    this.renderer = renderer;
    this.ctx = renderer;
    this.controller = controller;
    this.highlighter = highlighter;
    this.showHelp = false;
    this.showNotes = false;
    this.notesIndex = 0;
    this.deleteCandidate = null;
    this.renderVersion = 0;
    this.scrollFrameHandler = null;
    this.resizingSidebar = false;
    this.selectedDetachedNoteId = null;
    this.diffNavigation = [];
    this.pendingG = false;

    this.root = new BoxRenderable(this.ctx, {
      id: "review-root",
      width: "100%",
      height: "100%",
      flexDirection: "column",
      onMouseDrag: (event) => {
        if (this.resizingSidebar) this.resizeSidebar(event.x);
      },
      onMouseDragEnd: (event) => {
        if (this.resizingSidebar) this.finishSidebarResize(event.x);
      },
      onMouseUp: (event) => {
        if (this.resizingSidebar) this.finishSidebarResize(event.x);
      },
    });
    this.main = new BoxRenderable(this.ctx, {
      id: "review-main",
      flexGrow: 1,
      flexDirection: "row",
    });
    this.files = new ScrollBoxRenderable(this.ctx, {
      id: "review-files",
      width: 30,
      border: true,
      title: " files ",
      scrollY: true,
      scrollX: false,
    });
    this.splitter = new BoxRenderable(this.ctx, {
      id: "review-splitter",
      width: 1,
      shouldFill: false,
      onMouseDown: (event) => {
        this.resizingSidebar = true;
        event.preventDefault();
      },
      onMouseOver: () => {
        this.renderer.setMousePointer("move");
      },
      onMouseOut: () => {
        this.renderer.setMousePointer("default");
      },
    });
    this.diff = new ScrollBoxRenderable(this.ctx, {
      id: "review-diff",
      flexGrow: 1,
      border: true,
      title: " unified diff ",
      scrollY: true,
      scrollX: true,
    });
    this.bottom = new BoxRenderable(this.ctx, {
      id: "review-bottom",
      height: 3,
      border: true,
      title: " status ",
      flexDirection: "column",
    });
    this.main.add(this.files);
    this.main.add(this.splitter);
    this.main.add(this.diff);
    this.root.add(this.main);
    this.root.add(this.bottom);
    this.renderer.root.add(this.root);
    this.renderer.on(CliRenderEvents.RESIZE, () => {
      this.render();
    });
    this.bindKeys();
  }

  bindKeys() {
    this.renderer.keyInput.on("keypress", (key) => {
      if (key.eventType === "release") return;
      const name = shortcutName(key);
      if (key.ctrl && name === "c") return;
      if (this.controller.editor) {
        if (name === "escape") {
          key.preventDefault();
          this.controller.cancelEditor();
          this.render();
        } else if (key.ctrl && name === "s") {
          key.preventDefault();
          try {
            this.controller.saveEditor(this.editor.plainText);
          } catch (error) {
            this.controller.status = error.message;
          }
          this.render();
        }
        return;
      }

      if (name === "g") {
        key.preventDefault();
        if (this.pendingG) {
          this.pendingG = false;
          this.moveToFileBoundary("top");
        } else {
          this.pendingG = true;
          this.controller.status = "Press g again to jump to the top of this file.";
        }
        this.render();
        return;
      }
      const jumpToBottom = name === "G";
      this.pendingG = false;
      if (jumpToBottom) {
        key.preventDefault();
        this.moveToFileBoundary("bottom");
        this.render();
        return;
      }

      const defaultSidebarVisible = this.renderer.terminalWidth >= 72;
      if (this.showNotes && ["up", "k", "down", "j", "return"].includes(name)) {
        key.preventDefault();
        if (name === "return") {
          this.jumpToSelectedNote();
        } else {
          const delta = name === "up" || name === "k" ? -1 : 1;
          const count = this.controller.notes.length;
          if (count) this.notesIndex = (this.notesIndex + delta + count) % count;
        }
        this.render();
        return;
      }
      if (key.ctrl && (name === "u" || name === "d")) {
        key.preventDefault();
        this.moveHalfPage(name === "u" ? -1 : 1);
        this.render();
        return;
      }
      const scope = {
        1: "uncommitted",
        2: "branch",
        3: "last-turn",
      }[name];
      if (scope) {
        key.preventDefault();
        this.controller.switchScope(scope).finally(() => this.render());
        this.render();
        return;
      }
      const action =
        name === "up" || name === "k"
          ? () => this.moveDiffSelection(-1)
          : name === "down" || name === "j"
            ? () => this.moveDiffSelection(1)
            : name === "["
              ? () => {
                  this.selectedDetachedNoteId = null;
                  this.controller.moveHunk(-1);
                }
              : name === "]"
                ? () => {
                    this.selectedDetachedNoteId = null;
                    this.controller.moveHunk(1);
                  }
                : name === "{"
                  ? () => {
                      this.selectedDetachedNoteId = null;
                      this.controller.moveFile(-1);
                    }
                  : name === "}"
                    ? () => {
                        this.selectedDetachedNoteId = null;
                        this.controller.moveFile(1);
                      }
                    : name === "v"
                      ? () => this.controller.toggleRange()
                      : name === "s"
                        ? () => this.controller.toggleSide()
                      : name === "c"
                        ? () => this.controller.beginComment()
                        : name === "e"
                              ? () => {
                                  const note = this.showNotes
                                    ? this.selectedNote()
                                    : this.activeNote();
                                  if (!note) throw new Error("No saved note at this location.");
                                  this.controller.editNote(note.id);
                                }
                            : name === "x"
                                ? () => {
                                    const note = this.showNotes
                                      ? this.selectedNote()
                                      : this.activeNote();
                                    if (!note) throw new Error("No saved note at this location.");
                                    this.controller.toggleResolved(note.id);
                                    if (note.id === this.selectedDetachedNoteId) {
                                      this.selectedDetachedNoteId = null;
                                    }
                                  }
                              : name === "d"
                                ? () => this.confirmDelete()
                                : name === "b"
                                  ? () => this.controller.toggleSidebar(defaultSidebarVisible)
                                  : name === "w"
                                    ? () => {
                                        this.controller.toggleRowWrap();
                                        if (this.controller.rowWrap) {
                                          this.diff.scrollLeft = 0;
                                        }
                                      }
                                    : name === "n"
                                      ? () => {
                                          this.showNotes = !this.showNotes;
                                        }
                                      : name === "r"
                                        ? () => this.controller.refresh({ force: true })
                                        : name === "?" || name === "f1"
                                          ? () => {
                                              this.showHelp = !this.showHelp;
                                            }
                                          : name === "escape"
                                            ? () => this.escape()
                                            : null;
      if (!action) return;
      key.preventDefault();
      try {
        const result = action();
        if (result?.then) result.finally(() => this.render());
      } catch (error) {
        this.controller.status = error.message;
      }
      this.render();
    });
  }

  moveHalfPage(direction) {
    this.selectedDetachedNoteId = null;
    const visibleRows = Math.max(1, this.diff.viewport.height);
    this.controller.moveRow(direction * Math.max(1, Math.floor(visibleRows / 2)));
  }

  moveToFileBoundary(boundary) {
    const rowCount = this.controller.file?.rows.length ?? 0;
    if (!rowCount) {
      this.controller.status = "The current file has no diff rows.";
      return;
    }
    this.selectedDetachedNoteId = null;
    this.controller.rowIndex = boundary === "top" ? 0 : rowCount - 1;
    this.controller.rangeStart = null;
    this.controller.rangeEnd = null;
    this.controller.status =
      boundary === "top"
        ? "Moved to the top of the current file."
        : "Moved to the bottom of the current file.";
    this.controller.persistUI();
  }

  moveDiffSelection(delta) {
    if (!this.diffNavigation.length) {
      this.controller.moveRow(delta);
      return;
    }
    const currentKey = this.selectedDetachedNoteId
      ? `note:${this.selectedDetachedNoteId}`
      : `row:${this.controller.row?.id}`;
    const currentIndex = Math.max(
      0,
      this.diffNavigation.findIndex((target) => target.key === currentKey),
    );
    const nextIndex = Math.max(
      0,
      Math.min(this.diffNavigation.length - 1, currentIndex + delta),
    );
    const target = this.diffNavigation[nextIndex];
    if (target.type === "note") {
      this.selectedDetachedNoteId = target.noteId;
      if (Number.isInteger(target.rowIndex)) {
        this.controller.rowIndex = target.rowIndex;
      }
    } else {
      this.selectedDetachedNoteId = null;
      this.controller.rowIndex = target.rowIndex;
    }
    this.controller.rangeStart = null;
    this.controller.rangeEnd = null;
    this.controller.persistUI();
  }

  activeNote() {
    if (this.selectedDetachedNoteId) {
      return this.controller.notes.find(
        (note) => note.id === this.selectedDetachedNoteId,
      );
    }
    return noteAtRow(this.controller);
  }

  confirmDelete() {
    const note = this.showNotes
      ? this.selectedNote()
      : this.activeNote();
    if (!note) throw new Error("No saved note at this location.");
    if (this.deleteCandidate !== note.id) {
      this.deleteCandidate = note.id;
      this.controller.status = "Press d again to delete this saved note; Esc cancels.";
      return;
    }
    this.controller.deleteNote(note.id);
    if (note.id === this.selectedDetachedNoteId) {
      this.selectedDetachedNoteId = null;
    }
    this.deleteCandidate = null;
    this.controller.status = "Saved note deleted.";
  }

  escape() {
    if (this.deleteCandidate) {
      this.deleteCandidate = null;
    } else if (this.controller.rangeStart != null) {
      this.controller.rangeStart = null;
      this.controller.rangeEnd = null;
    } else if (this.showHelp) {
      this.showHelp = false;
    } else if (this.showNotes) {
      this.showNotes = false;
    }
  }

  selectedNote() {
    const notes = this.controller.notes;
    if (!notes.length) return undefined;
    this.notesIndex = Math.min(this.notesIndex, notes.length - 1);
    return notes[this.notesIndex];
  }

  jumpToSelectedNote() {
    const note = this.selectedNote();
    if (!note) return;
    const fileIndex = this.controller.model.files.findIndex(
      (file) =>
        file.path === note.anchor.path ||
        file.previousPath === note.anchor.path,
    );
    if (fileIndex < 0) {
      this.controller.status = "The selected note location is stale.";
      return;
    }
    this.controller.fileIndex = fileIndex;
    this.selectedDetachedNoteId =
      note.status === "stale" && note.resolvedAt == null ? note.id : null;
    const file = this.controller.file;
    const rowIndex = file.rows.findIndex((row) => {
      const line =
        note.anchor.side === "old" ? row.oldLine : row.newLine;
      return line === note.anchor.startLine;
    });
    this.controller.rowIndex = Math.max(0, rowIndex);
    this.controller.persistUI();
    this.showNotes = false;
  }

  async render() {
    const version = ++this.renderVersion;
    const narrow = this.renderer.terminalWidth < 72;
    const sidebarVisible =
      this.controller.sidebarVisible ?? !narrow;
    const sidebarWidth = this.clampedSidebarWidth();
    this.diff.title = ` ${
      this.controller.source.describeScope?.() ?? this.controller.scope
    }${this.controller.rowWrap ? " · wrap" : ""} `;
    this.files.visible = sidebarVisible;
    this.files.width = sidebarVisible ? (narrow ? "100%" : sidebarWidth) : 0;
    this.splitter.visible = sidebarVisible && !narrow;
    this.splitter.width = this.splitter.visible ? 1 : 0;
    this.main.flexDirection = narrow ? "column" : "row";
    if (narrow) this.files.height = sidebarVisible ? "45%" : 0;

    clear(this.files);
    clear(this.diff);
    clear(this.bottom);
    this.renderFiles();
    await this.renderDiff(version);
    this.renderBottom();
    this.scrollSelectedRowAfterLayout(version);
    this.renderer.requestRender();
  }

  setDiffNavigation(file, placements = { byEndRow: new Map(), placedIds: new Set() }) {
    const targets = [];
    for (const [rowIndex, row] of (file?.rows ?? []).entries()) {
      targets.push({
        key: `row:${row.id}`,
        type: "row",
        rowIndex,
      });
      for (const note of placements.byEndRow.get(row.id) ?? []) {
        targets.push({
          key: `note:${note.id}`,
          type: "note",
          noteId: note.id,
          rowIndex,
        });
      }
    }
    for (
      const note of this.controller.detachedOpenNotes
        .filter((candidate) => !placements.placedIds.has(candidate.id))
        .slice(0, 20)
    ) {
      targets.push({
        key: `note:${note.id}`,
        type: "note",
        noteId: note.id,
        rowIndex: file?.rows.length ? file.rows.length - 1 : undefined,
      });
    }
    this.diffNavigation = targets;
  }

  scrollSelectedRowAfterLayout(version) {
    const selectedId = this.selectedDetachedNoteId
      ? `detached-note:${this.selectedDetachedNoteId}`
      : this.controller.row?.id
        ? `row:${this.controller.row.id}`
        : null;
    if (!selectedId) return;
    if (this.scrollFrameHandler) {
      this.renderer.off(CliRenderEvents.FRAME, this.scrollFrameHandler);
    }
    const handler = () => {
      if (this.scrollFrameHandler === handler) {
        this.scrollFrameHandler = null;
      }
      if (version !== this.renderVersion) return;
      this.diff.scrollChildIntoView(selectedId);
      this.renderer.requestRender();
    };
    this.scrollFrameHandler = handler;
    this.renderer.once(CliRenderEvents.FRAME, handler);
  }

  clampedSidebarWidth() {
    const available = Math.max(
      MIN_SIDEBAR_WIDTH,
      this.renderer.terminalWidth - MIN_DIFF_WIDTH,
    );
    return Math.max(
      MIN_SIDEBAR_WIDTH,
      Math.min(
        MAX_SIDEBAR_WIDTH,
        available,
        this.controller.sidebarWidth,
      ),
    );
  }

  resizeSidebar(terminalX, { persist = false } = {}) {
    if (this.renderer.terminalWidth < 72 || !this.files.visible) return;
    const next = terminalX - this.main.x;
    const max = Math.max(
      MIN_SIDEBAR_WIDTH,
      Math.min(
        MAX_SIDEBAR_WIDTH,
        this.renderer.terminalWidth - MIN_DIFF_WIDTH,
      ),
    );
    const width = Math.max(MIN_SIDEBAR_WIDTH, Math.min(max, next));
    this.controller.setSidebarWidth(width, { persist });
    this.files.width = width;
    this.renderer.requestRender();
  }

  finishSidebarResize(terminalX) {
    this.resizeSidebar(terminalX, { persist: true });
    this.resizingSidebar = false;
    this.renderer.setMousePointer("default");
  }

  renderFiles() {
    const notesByPath = new Map();
    for (const note of this.controller.openNotes) {
      notesByPath.set(note.anchor.path, (notesByPath.get(note.anchor.path) ?? 0) + 1);
    }
    this.controller.model.files.forEach((file, index) => {
      const selected = index === this.controller.fileIndex;
      const status = {
        added: "A",
        deleted: "D",
        renamed: "R",
        modified: "M",
      }[file.status] ?? "•";
      const count = notesByPath.get(file.path) ?? 0;
      const item = text(
        this.ctx,
        `file:${file.id}`,
        `${selected ? "›" : " "} ${status} ${terminalSafeText(file.path)}${count ? ` (${count})` : ""}`,
        {
          backgroundColor: selected ? COLORS.selected : undefined,
          fg: selected ? COLORS.accent : COLORS.context,
          selectable: false,
          onMouseDown: () => {
            this.controller.selectFile(index);
            this.render();
          },
        },
      );
      this.files.add(item);
    });
  }

  async renderDiff(version) {
    const file = this.controller.file;
    const wrappedRowWidth = Math.max(
      1,
      this.diff.viewport.width || this.diff.width,
    );
    if (!file) {
      this.setDiffNavigation(null);
      this.diff.add(
        text(
          this.ctx,
          "empty",
          this.controller.model.waiting
            ? "Waiting for the next observed agent turn."
            : `No changes in ${scopeLabel(this.controller.scope)} scope.`,
        ),
      );
      this.renderDetachedNotes();
      return;
    }
    if (file.kind !== "text") {
      this.setDiffNavigation(file);
      this.diff.add(
        text(
          this.ctx,
          `nontext:${file.id}`,
          `${file.kind.toUpperCase()}: ${terminalSafeText(file.path)}\n${file.header.map(terminalSafeText).join("\n")}`,
          { height: Math.max(2, file.header.length + 1), fg: COLORS.warning },
        ),
      );
      this.renderDetachedNotes();
      return;
    }

    const detached = detachedPlacements(this.controller, file);
    this.setDiffNavigation(file, detached);
    const filetype = detectFiletype(file.path, file.rows[0]?.text ?? "");
    this.diff.add(
      text(
        this.ctx,
        `file-header:${file.id}`,
        file.previousPath
          ? `${terminalSafeText(file.previousPath)} → ${terminalSafeText(file.path)}`
          : terminalSafeText(file.path),
        { fg: COLORS.warning },
      ),
    );
    let rowIndex = 0;
    for (const hunk of file.hunks) {
      this.diff.add(
        text(
          this.ctx,
          `hunk:${hunk.id}`,
          `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@ ${hunk.header}`,
          { fg: COLORS.accent },
        ),
      );
      for (const row of hunk.rows) {
        const currentIndex = rowIndex;
        rowIndex += 1;
        const selected =
          (this.selectedDetachedNoteId == null &&
            currentIndex === this.controller.rowIndex) ||
          (this.controller.rangeStart != null &&
            currentIndex >= Math.min(
              this.controller.rangeStart,
              this.controller.rangeEnd ?? this.controller.rowIndex,
            ) &&
            currentIndex <= Math.max(
              this.controller.rangeStart,
              this.controller.rangeEnd ?? this.controller.rowIndex,
            ));
        const rowNotes = this.controller.notes.filter((note) => {
          const line = note.anchor.side === "old" ? row.oldLine : row.newLine;
          return (
            note.status === "anchored" &&
            (note.anchor.path === file.path ||
              note.anchor.path === file.previousPath) &&
            line != null &&
            line >= note.anchor.startLine &&
            line <= note.anchor.endLine
          );
        });
        const detachedRowNotes = detached.byEndRow.get(row.id) ?? [];
        const container = new BoxRenderable(this.ctx, {
          id: `row:${row.id}`,
          height: this.controller.rowWrap ? "auto" : 1,
          minHeight: 1,
          width: this.controller.rowWrap ? wrappedRowWidth : undefined,
          flexDirection: "row",
          backgroundColor: rowBackground(row, selected),
          onMouseDown: (event) => {
            this.selectedDetachedNoteId = null;
            if (event.modifiers.shift && this.controller.rangeStart == null) {
              this.controller.rangeStart = this.controller.rowIndex;
              this.controller.rangeEnd = null;
            }
            this.controller.rowIndex = currentIndex;
            this.render();
          },
          onMouseDrag: () => {
            this.selectedDetachedNoteId = null;
            if (this.controller.rangeStart == null) {
              this.controller.rangeStart = this.controller.rowIndex;
              this.controller.rangeEnd = null;
            }
            this.controller.rowIndex = currentIndex;
            this.render();
          },
        });
        container.add(
          text(
            this.ctx,
            `prefix:${row.id}`,
            `${
              rowNotes.some((note) => note.resolvedAt == null)
                ? "●"
                : detachedRowNotes.length
                  ? "!"
                : rowNotes.length
                  ? "✓"
                  : " "
            }${rowPrefix(row)}`,
            {
              width: 13,
              fg:
                row.kind === "addition"
                  ? COLORS.addition
                  : row.kind === "deletion"
                    ? COLORS.deletion
                    : COLORS.muted,
            },
          ),
        );
        const highlighted = row.commentable
          ? await this.highlighter.highlight(
              terminalSafeText(row.text),
              filetype,
              `${file.generation}:${row.id}`,
            )
          : terminalSafeText(row.text);
        if (version !== this.renderVersion) return;
        container.add(
          text(this.ctx, `code:${row.id}`, highlighted, {
            height: this.controller.rowWrap ? "auto" : 1,
            width: this.controller.rowWrap ? 0 : undefined,
            flexGrow: 1,
            flexShrink: this.controller.rowWrap ? 1 : 0,
            wrapMode: this.controller.rowWrap ? "char" : "none",
            fg:
              row.kind === "addition"
                ? COLORS.addition
                : row.kind === "deletion"
                  ? COLORS.deletion
                  : COLORS.context,
          }),
        );
        this.diff.add(container);
        for (const note of notesEndingAtRow(this.controller, file, row)) {
          this.addCommentCard(note);
        }
        for (const note of detachedRowNotes) {
          this.addCommentCard(note, { detached: true, inline: true });
        }
      }
    }
    this.renderDetachedNotes(detached.placedIds);
    if (
      this.selectedDetachedNoteId &&
      !this.diffNavigation.some(
        (target) => target.noteId === this.selectedDetachedNoteId,
      )
    ) {
      this.selectedDetachedNoteId = null;
    }
  }

  addCommentCard(note, { detached = false, inline = false } = {}) {
    const resolved = note.resolvedAt != null;
    const body = terminalSafeText(note.body);
    const bodyHeight = Math.max(1, body.split("\n").length);
    const location =
      `${terminalSafeText(note.anchor.path)}:${note.anchor.startLine}-${note.anchor.endLine}`;
    const title = detached
      ? ` open · detached · ${location} `
      : resolved
        ? " resolved comment "
        : " open comment ";
    const color = resolved
      ? COLORS.muted
      : detached
        ? COLORS.warning
        : COLORS.accent;
    const comment = new BoxRenderable(this.ctx, {
      id: `${detached ? "detached-note" : "note"}:${note.id}`,
      height: bodyHeight + 2,
      marginLeft: detached && !inline ? 0 : 12,
      border: true,
      borderColor: color,
      backgroundColor:
        note.id === this.selectedDetachedNoteId ? COLORS.selected : undefined,
      title,
      titleColor: color,
      flexDirection: "column",
      onMouseDown: () => {
        if (!detached) return;
        this.selectedDetachedNoteId = note.id;
        this.render();
      },
    });
    comment.add(
      text(this.ctx, `note-body:${note.id}`, body, {
        height: bodyHeight,
        fg: resolved ? COLORS.muted : COLORS.context,
      }),
    );
    this.diff.add(comment);
  }

  renderDetachedNotes(placedIds = new Set()) {
    const detached = this.controller.detachedOpenNotes.filter(
      (note) => !placedIds.has(note.id),
    );
    if (!detached.length) return;
    this.diff.add(
      text(
        this.ctx,
        "detached-notes-header",
        `⚠ ${detached.length} open detached comment${detached.length === 1 ? "" : "s"} · press n to review · x resolves selected`,
        { fg: COLORS.warning },
      ),
    );
    const visible = detached.slice(0, 20);
    for (const note of visible) {
      this.addCommentCard(note, { detached: true });
    }
    if (detached.length > visible.length) {
      this.diff.add(
        text(
          this.ctx,
          "detached-notes-more",
          `…and ${detached.length - visible.length} more; press n to review all saved comments.`,
          { fg: COLORS.warning },
        ),
      );
    }
  }

  renderBottom() {
    if (this.controller.editor) {
      this.bottom.height = 8;
      const editorError =
        this.controller.status.startsWith("A saved note") ||
        this.controller.status.startsWith("Invalid review store") ||
        this.controller.status.startsWith("Refresh failed");
      this.bottom.title = ` comment — Ctrl+S save · Esc cancel${editorError ? ` · ${this.controller.status}` : ""} `;
      const editor = new TextareaRenderable(this.ctx, {
        id: "comment-editor",
        flexGrow: 1,
        initialValue: this.controller.editor.value,
        placeholder: "Write a human review comment…",
        wrapMode: "word",
      });
      editor.onContentChange = () => {
        if (this.controller.editor) {
          this.controller.editor.value = editor.plainText;
        }
      };
      this.editor = editor;
      this.bottom.add(this.editor);
      this.editor.focus();
      return;
    }
    this.bottom.height = this.showHelp || this.showNotes ? 8 : 3;
    this.bottom.title = this.showHelp
      ? " help "
      : this.showNotes
        ? this.deleteCandidate
          ? " saved notes — press d again to delete · Esc cancel "
          : " saved notes — ↑/↓ select · Enter jump · x resolve/reopen · e edit · d delete "
        : " status ";
    if (this.showHelp) {
      this.bottom.add(
        text(
          this.ctx,
          "help",
          `1 working · 2 branch · 3 last turn · ↑/k ↓/j rows · gg/G file top/bottom · Ctrl+U/D half-page · [ ] change blocks · { } files\nb sidebar · w row wrap · v range · s context target · c comment · e edit · x resolve/reopen · n notes · d d delete · r refresh · Esc cancel`,
          { height: 2 },
        ),
      );
    } else if (this.showNotes) {
      const allLines = this.controller.notes.map(
        (note, index) => {
          const state =
            note.resolvedAt != null
              ? `✓ resolved${note.status === "stale" ? " · detached" : ""}`
              : note.status === "stale"
                ? "⚠ open · detached"
                : "● open";
          return `${index === this.notesIndex ? "›" : " "} ${index + 1}. ${state} · ${note.anchor.path}:${note.anchor.startLine}-${note.anchor.endLine} ${note.body.split("\n")[0]}`;
        },
      );
      const start = Math.max(
        0,
        Math.min(
          this.notesIndex - 2,
          Math.max(0, allLines.length - 6),
        ),
      );
      const lines = allLines.slice(start, start + 6);
      this.bottom.add(
        text(this.ctx, "notes-list", lines.join("\n") || "No saved notes.", {
          height: Math.max(1, Math.min(6, lines.length)),
        }),
      );
    } else {
      const open = this.controller.openNotes.length;
      const resolved = this.controller.resolvedNotes.length;
      const detached = this.controller.detachedOpenNotes.length;
      const summary =
        `${open} open · ${resolved} resolved` +
        (detached ? ` · ${detached} detached` : "");
      this.bottom.add(
        text(
          this.ctx,
          "status-text",
          `${this.controller.status}  ${summary} · ${commentTarget(this.controller)} · b sidebar · w wrap · ?/F1 help · r refresh · c comment · n notes`,
          { fg: this.controller.status.startsWith("Refresh failed") ? COLORS.warning : COLORS.context },
        ),
      );
    }
  }
}
