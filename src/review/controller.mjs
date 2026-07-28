import {
  createAnchor,
  reanchorNote,
} from "./anchors.mjs";
import { normalizeScope, noteMatchesScope, scopeLabel } from "./scopes.mjs";
import { createHumanNote, saveStore } from "./store.mjs";

export class ReviewController {
  constructor({ source, store, stateDir }) {
    this.source = source;
    this.store = store;
    this.stateDir = stateDir;
    this.model = { generation: 0, files: [] };
    this.fileIndex = 0;
    this.rowIndex = 0;
    this.rangeStart = null;
    this.rangeEnd = null;
    this.preferredSide = "new";
    this.sidebarVisible = store.ui?.sidebarVisible ?? null;
    this.sidebarWidth = store.ui?.sidebarWidth ?? 30;
    this.scope = normalizeScope(store.ui?.scope);
    this.source.setScope?.(this.scope);
    this.editor = null;
    this.refreshing = false;
    this.refreshQueued = false;
    this.status = "Loading changes…";
  }

  get file() {
    return this.model.files[this.fileIndex];
  }

  get row() {
    return this.file?.rows[this.rowIndex];
  }

  get notes() {
    return this.store.notes.filter((note) =>
      noteMatchesScope(
        note,
        this.scope,
        this.source.scopeIdentity?.() ?? null,
      ),
    );
  }

  async refresh({ force = false } = {}) {
    if (this.refreshing) {
      this.refreshQueued = true;
      return false;
    }
    this.refreshing = true;
    const preserved = {
      filePath: this.file?.path,
      rowId: this.row?.id,
      anchor: this.editor?.anchor,
    };
    try {
      const status = await this.source.status();
      if (!force && status.fingerprint === this.model.fingerprint) {
        this.status =
          this.scope === "last-turn" && this.source.turnTrackingError
            ? `Last-turn tracking unavailable: ${this.source.turnTrackingError}`
            : this.scope === "last-turn" &&
                (!this.source.turnBaseline || !this.source.turnTarget)
              ? "Waiting for the next observed agent turn."
              : `No ${scopeLabel(this.scope)} changes since last refresh.`;
        return false;
      }
      const next = await this.source.refresh(
        this.model.generation + 1,
        status,
      );
      this.model = next;
      this.fileIndex = Math.max(
        0,
        next.files.findIndex((file) => file.path === preserved.filePath),
      );
      this.rowIndex = Math.max(
        0,
        this.file?.rows.findIndex((row) => row.id === preserved.rowId) ?? 0,
      );
      this.store = {
        ...this.store,
        notes: this.store.notes.map((note) =>
          noteMatchesScope(
            note,
            this.scope,
            this.source.scopeIdentity?.() ?? null,
          )
            ? reanchorNote(note, next)
            : note
        ),
        ui: this.uiState(),
      };
      this.store = saveStore(this.stateDir, this.store);
      this.status = next.waiting
        ? "Waiting for the next observed agent turn."
        : `${scopeLabel(this.scope)}: ${next.files.length} changed file${next.files.length === 1 ? "" : "s"}.`;
      return true;
    } catch (error) {
      this.status = `Refresh failed: ${error.message}`;
      return false;
    } finally {
      this.refreshing = false;
      if (this.refreshQueued) {
        this.refreshQueued = false;
        queueMicrotask(() => this.refresh({ force: true }));
      }
    }
  }

  moveRow(delta) {
    const count = this.file?.rows.length ?? 0;
    if (!count) return;
    this.rowIndex = Math.max(0, Math.min(count - 1, this.rowIndex + delta));
    this.persistUI();
  }

  async switchScope(scope) {
    const nextScope = normalizeScope(scope);
    if (nextScope === this.scope) return false;
    if (this.editor) {
      this.status = "Save or cancel the active comment before switching scope.";
      return false;
    }
    this.scope = nextScope;
    this.source.setScope?.(nextScope);
    this.fileIndex = 0;
    this.rowIndex = 0;
    this.rangeStart = null;
    this.rangeEnd = null;
    this.model = {
      generation: this.model.generation,
      files: [],
      fingerprint: null,
    };
    this.persistUI();
    return this.refresh({ force: true });
  }

  moveFile(delta) {
    const count = this.model.files.length;
    if (!count) return;
    this.fileIndex = (this.fileIndex + delta + count) % count;
    this.rowIndex = 0;
    this.rangeStart = null;
    this.rangeEnd = null;
    this.persistUI();
  }

  selectFile(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.model.files.length) {
      return;
    }
    this.fileIndex = index;
    this.rowIndex = 0;
    this.rangeStart = null;
    this.rangeEnd = null;
    this.persistUI();
  }

  toggleSidebar(defaultVisible = true) {
    this.sidebarVisible = !(this.sidebarVisible ?? defaultVisible);
    this.persistUI();
  }

  setSidebarWidth(width, { persist = false } = {}) {
    this.sidebarWidth = Math.max(18, Math.min(80, Math.round(width)));
    if (persist) this.persistUI();
  }

  moveHunk(delta) {
    const hunks = this.file?.hunks ?? [];
    if (!hunks.length) return;
    const current = hunks.findIndex((hunk) =>
      hunk.rows.some((row) => row.id === this.row?.id),
    );
    const target = hunks[Math.max(0, Math.min(hunks.length - 1, current + delta))];
    const rowId = target?.rows.find((row) => row.commentable)?.id;
    this.rowIndex = Math.max(0, this.file.rows.findIndex((row) => row.id === rowId));
    this.persistUI();
  }

  toggleRange() {
    if (!this.row?.commentable) return;
    if (this.rangeStart == null) {
      this.rangeStart = this.rowIndex;
      this.rangeEnd = null;
    } else if (this.rangeEnd == null) {
      this.rangeEnd = this.rowIndex;
    } else {
      this.rangeStart = null;
      this.rangeEnd = null;
    }
  }

  toggleSide() {
    if (!this.row?.commentable) {
      this.status = "Select a commentable diff line before choosing a side.";
      return false;
    }
    if (this.row.kind === "addition") {
      this.status = `Added lines only exist on NEW line ${this.row.newLine}.`;
      return false;
    }
    if (this.row.kind === "deletion") {
      this.status = `Deleted lines only exist on OLD line ${this.row.oldLine}.`;
      return false;
    }
    this.preferredSide =
      this.preferredSide === "new" ? "old" : "new";
    const line =
      this.preferredSide === "old" ? this.row.oldLine : this.row.newLine;
    this.status =
      `Context comment target: ${this.preferredSide.toUpperCase()} line ${line}.`;
    return true;
  }

  selectedRows() {
    if (!this.file || !this.row) return [];
    const selectionEnd = this.rangeEnd ?? this.rowIndex;
    const start = this.rangeStart == null
      ? this.rowIndex
      : Math.min(this.rangeStart, selectionEnd);
    const end = this.rangeStart == null
      ? this.rowIndex
      : Math.max(this.rangeStart, selectionEnd);
    return this.file.rows.slice(start, end + 1);
  }

  beginComment() {
    const anchor = createAnchor(
      this.file,
      this.selectedRows(),
      this.model.generation,
      this.preferredSide,
    );
    this.editor = { mode: "create", noteId: null, anchor, value: "" };
    this.rangeStart = null;
    this.rangeEnd = null;
  }

  editNote(noteId) {
    const note = this.store.notes.find((candidate) => candidate.id === noteId);
    if (!note) throw new Error("Saved note was not found.");
    this.editor = {
      mode: "edit",
      noteId,
      anchor: note.anchor,
      value: note.body,
    };
  }

  cancelEditor() {
    this.editor = null;
  }

  saveEditor(body) {
    if (!body.trim()) throw new Error("A saved note cannot be empty.");
    const notes = [...this.store.notes];
    if (this.editor.mode === "edit") {
      const index = notes.findIndex((note) => note.id === this.editor.noteId);
      if (index < 0) throw new Error("Saved note was not found.");
      notes[index] = {
        ...notes[index],
        body,
        updatedAt: new Date().toISOString(),
      };
    } else {
      notes.push(
        reanchorNote(
          createHumanNote(
            body,
            this.editor.anchor,
            "",
            this.scope,
            this.source.scopeIdentity?.() ?? null,
          ),
          this.model,
        ),
      );
    }
    this.store = saveStore(this.stateDir, { ...this.store, notes });
    this.editor = null;
    return this.store;
  }

  deleteNote(noteId) {
    const notes = this.store.notes.filter((note) => note.id !== noteId);
    if (notes.length === this.store.notes.length) {
      throw new Error("Saved note was not found.");
    }
    this.store = saveStore(this.stateDir, { ...this.store, notes });
  }

  persistUI() {
    if (!this.store) return;
    this.store = saveStore(this.stateDir, {
      ...this.store,
      ui: this.uiState(),
    });
  }

  uiState() {
    return {
      filePath: this.file?.path ?? null,
      rowId: this.row?.id ?? null,
      sidebarVisible: this.sidebarVisible,
      sidebarWidth: this.sidebarWidth,
      scope: this.scope,
      scopeBase: this.source.scopeIdentity?.() ?? null,
    };
  }
}
