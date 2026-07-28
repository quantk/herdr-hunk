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
  return controller.notes.find((note) => {
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
          ? () => this.controller.moveRow(-1)
          : name === "down" || name === "j"
            ? () => this.controller.moveRow(1)
            : name === "["
              ? () => this.controller.moveHunk(-1)
              : name === "]"
                ? () => this.controller.moveHunk(1)
                : name === "{"
                  ? () => this.controller.moveFile(-1)
                  : name === "}"
                    ? () => this.controller.moveFile(1)
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
                                : noteAtRow(this.controller);
                              if (!note) throw new Error("No saved note at this location.");
                              this.controller.editNote(note.id);
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
    const visibleRows = Math.max(1, this.diff.viewport.height);
    this.controller.moveRow(direction * Math.max(1, Math.floor(visibleRows / 2)));
  }

  confirmDelete() {
    const note = this.showNotes
      ? this.selectedNote()
      : noteAtRow(this.controller);
    if (!note) throw new Error("No saved note at this location.");
    if (this.deleteCandidate !== note.id) {
      this.deleteCandidate = note.id;
      this.controller.status = "Press d again to delete this saved note; Esc cancels.";
      return;
    }
    this.controller.deleteNote(note.id);
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

  scrollSelectedRowAfterLayout(version) {
    const selectedId = this.controller.row?.id;
    if (!selectedId) return;
    if (this.scrollFrameHandler) {
      this.renderer.off(CliRenderEvents.FRAME, this.scrollFrameHandler);
    }
    const handler = () => {
      if (this.scrollFrameHandler === handler) {
        this.scrollFrameHandler = null;
      }
      if (version !== this.renderVersion) return;
      this.diff.scrollChildIntoView(`row:${selectedId}`);
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
    for (const note of this.controller.notes) {
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
      this.diff.add(
        text(
          this.ctx,
          "empty",
          this.controller.model.waiting
            ? "Waiting for the next observed agent turn."
            : `No changes in ${scopeLabel(this.controller.scope)} scope.`,
        ),
      );
      return;
    }
    if (file.kind !== "text") {
      this.diff.add(
        text(
          this.ctx,
          `nontext:${file.id}`,
          `${file.kind.toUpperCase()}: ${terminalSafeText(file.path)}\n${file.header.map(terminalSafeText).join("\n")}`,
          { height: Math.max(2, file.header.length + 1), fg: COLORS.warning },
        ),
      );
      return;
    }

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
          currentIndex === this.controller.rowIndex ||
          (this.controller.rangeStart != null &&
            currentIndex >= Math.min(
              this.controller.rangeStart,
              this.controller.rangeEnd ?? this.controller.rowIndex,
            ) &&
            currentIndex <= Math.max(
              this.controller.rangeStart,
              this.controller.rangeEnd ?? this.controller.rowIndex,
            ));
        const saved = this.controller.notes.some((note) => {
          const line = note.anchor.side === "old" ? row.oldLine : row.newLine;
          return (
            note.anchor.path === file.path &&
            line != null &&
            line >= note.anchor.startLine &&
            line <= note.anchor.endLine
          );
        });
        const container = new BoxRenderable(this.ctx, {
          id: `row:${row.id}`,
          height: this.controller.rowWrap ? "auto" : 1,
          minHeight: 1,
          width: this.controller.rowWrap ? wrappedRowWidth : undefined,
          flexDirection: "row",
          backgroundColor: rowBackground(row, selected),
          onMouseDown: (event) => {
            if (event.modifiers.shift && this.controller.rangeStart == null) {
              this.controller.rangeStart = this.controller.rowIndex;
              this.controller.rangeEnd = null;
            }
            this.controller.rowIndex = currentIndex;
            this.render();
          },
          onMouseDrag: () => {
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
            `${saved ? "●" : " "}${rowPrefix(row)}`,
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
          const body = terminalSafeText(note.body);
          const bodyHeight = Math.max(1, body.split("\n").length);
          const comment = new BoxRenderable(this.ctx, {
            id: `note:${note.id}`,
            height: bodyHeight + 2,
            marginLeft: 12,
            border: true,
            borderColor: COLORS.accent,
            title: " saved comment ",
            titleColor: COLORS.accent,
            flexDirection: "column",
          });
          comment.add(
            text(this.ctx, `note-body:${note.id}`, body, {
              height: bodyHeight,
              fg: COLORS.context,
            }),
          );
          this.diff.add(comment);
        }
      }
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
          : " saved notes — ↑/↓ select · Enter jump · e edit · d delete "
        : " status ";
    if (this.showHelp) {
      this.bottom.add(
        text(
          this.ctx,
          "help",
          `1 working · 2 branch · 3 last turn · ↑/k ↓/j rows · Ctrl+U/D half-page · [ ] change blocks · { } files\nb sidebar · w row wrap · v range · s context target · c comment · e edit · n notes · d d delete · r refresh · Esc cancel`,
          { height: 2 },
        ),
      );
    } else if (this.showNotes) {
      const allLines = this.controller.notes.map(
        (note, index) =>
          `${index === this.notesIndex ? "›" : " "} ${index + 1}. ${note.status === "stale" ? "⚠ stale " : ""}${note.anchor.path}:${note.anchor.startLine}-${note.anchor.endLine} ${note.body.split("\n")[0]}`,
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
      this.bottom.add(
        text(
          this.ctx,
          "status-text",
          `${this.controller.status}  ${commentTarget(this.controller)} · b sidebar · w wrap · ?/F1 help · r refresh · c comment · n notes`,
          { fg: this.controller.status.startsWith("Refresh failed") ? COLORS.warning : COLORS.context },
        ),
      );
    }
  }
}
