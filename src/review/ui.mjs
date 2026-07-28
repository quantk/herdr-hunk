import {
  BoxRenderable,
  CliRenderEvents,
  ScrollBoxRenderable,
  TextareaRenderable,
  TextRenderable,
} from "@opentui/core";
import { detectFiletype } from "./languages.mjs";
import { terminalSafeText } from "./model.mjs";

const COLORS = {
  border: "#5c6370",
  selected: "#30384a",
  addition: "#98c379",
  deletion: "#e06c75",
  context: "#abb2bf",
  muted: "#7f848e",
  warning: "#e5c07b",
  accent: "#61afef",
};

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
  return controller.store.notes.find((note) => {
    if (note.anchor.path !== file.path) return false;
    const line =
      note.anchor.side === "old" ? row.oldLine : row.newLine;
    return (
      line != null &&
      line >= note.anchor.startLine &&
      line <= note.anchor.endLine
    );
  });
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

    this.root = new BoxRenderable(this.ctx, {
      id: "review-root",
      width: "100%",
      height: "100%",
      flexDirection: "column",
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
      if (key.ctrl && key.name === "c") return;
      if (this.controller.editor) {
        if (key.name === "escape") {
          key.preventDefault();
          this.controller.cancelEditor();
          this.render();
        } else if (key.ctrl && key.name === "s") {
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

      const name = key.name;
      if (this.showNotes && ["up", "k", "down", "j", "return"].includes(name)) {
        key.preventDefault();
        if (name === "return") {
          this.jumpToSelectedNote();
        } else {
          const delta = name === "up" || name === "k" ? -1 : 1;
          const count = this.controller.store.notes.length;
          if (count) this.notesIndex = (this.notesIndex + delta + count) % count;
        }
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
                            : name === "n"
                              ? () => {
                                  this.showNotes = !this.showNotes;
                                }
                              : name === "r"
                                ? () => this.controller.refresh({ force: true })
                              : name === "?"
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
    const notes = this.controller.store.notes;
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
    this.files.visible = !narrow || this.showNotes;
    this.files.width = narrow ? "100%" : 30;
    this.main.flexDirection = narrow ? "column" : "row";
    if (narrow) this.files.height = this.showNotes ? "45%" : 0;

    clear(this.files);
    clear(this.diff);
    clear(this.bottom);
    this.renderFiles();
    await this.renderDiff(version);
    this.renderBottom();
    this.renderer.requestRender();
  }

  renderFiles() {
    const notesByPath = new Map();
    for (const note of this.controller.store.notes) {
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
          onMouseDown: () => {
            this.controller.fileIndex = index;
            this.controller.rowIndex = 0;
            this.render();
          },
        },
      );
      this.files.add(item);
    });
  }

  async renderDiff(version) {
    const file = this.controller.file;
    if (!file) {
      this.diff.add(text(this.ctx, "empty", "Working tree is clean."));
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
        const saved = this.controller.store.notes.some((note) => {
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
          height: 1,
          flexDirection: "row",
          backgroundColor: selected ? COLORS.selected : undefined,
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
            flexGrow: 1,
            fg:
              row.kind === "addition"
                ? COLORS.addition
                : row.kind === "deletion"
                  ? COLORS.deletion
                  : COLORS.context,
          }),
        );
        this.diff.add(container);
      }
    }
    const selectedId = this.controller.row?.id;
    if (selectedId) this.diff.scrollChildIntoView(`row:${selectedId}`);
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
          `↑/k ↓/j rows · [ ] hunks · { } files · v range · s side (${this.controller.preferredSide}) · c comment · e edit\nn notes (↑/↓, Enter jump) · d d delete · r refresh · ? help · Esc cancel · mouse click/Shift-click/drag`,
          { height: 2 },
        ),
      );
    } else if (this.showNotes) {
      const allLines = this.controller.store.notes.map(
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
          `${this.controller.status}  side:${this.controller.preferredSide} · ? help · r refresh · c comment · n notes`,
          { fg: this.controller.status.startsWith("Refresh failed") ? COLORS.warning : COLORS.context },
        ),
      );
    }
  }
}
