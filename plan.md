# Native Review Pane Implementation Plan

Status: implemented; release preparation remains a separate explicit action.

Last updated: 2026-07-28.

## 1. Goal

Replace the external Hunk application with a small, purpose-built review pane
for this Herdr plugin.

The replacement must preserve the current user workflow:

1. `F6` opens a live working-tree review beside the focused coding agent.
2. The review remains associated with that exact agent pane and Git repository.
3. The user can navigate the diff and save inline human comments.
4. `F6` hides and restores the same live pane without terminating it or losing
   its state.
5. `F7` finds the correct active review, focuses its source agent, and inserts
   the saved comments as one editable draft.
6. The plugin never presses Enter or submits the draft automatically.

The new pane is not intended to reproduce Hunk as a product. It only needs the
diff-review functionality required by this plugin.

## 2. Fixed product decisions

- Use Bun for the interactive review-pane runtime.
- Keep `open-review`, `send-notes`, shared state handling, and the Herdr socket
  client compatible with Node.js 18.
- Use the imperative `@opentui/core` API. Do not add React or JSX for the first
  implementation.
- Tree-sitter syntax highlighting is a release requirement, not a later
  enhancement.
- A unified diff is required. A split/side-by-side diff is not required for the
  first release.
- Keyboard operation is required. Basic mouse selection and scrolling are also
  required before the Hunk-backed implementation is removed.
- The review is strictly read-only with respect to Git. It must not stage,
  unstage, revert, edit files, write refs, create commits, or mutate the user's
  working tree.
- Only comments explicitly created and saved by the human reviewer may be sent
  to the agent.
- Keep the existing plugin ID, action IDs, pane ID, `reviewKey`, and default
  `F6`/`F7` workflow during the migration. This preserves installed keybindings
  and existing review associations.
- Remove the Hunk executable/runtime dependency after the native pane passes the
  complete acceptance suite. Do not ship a permanent dual-backend design.

The initial technical baseline verified during planning was Bun 1.3.14 and
`@opentui/core` 0.4.5. Recheck the current compatible versions when
implementation starts, pin `@opentui/core` exactly, and commit the Bun lockfile.
OpenTUI is still pre-1.0, so upgrades must be deliberate and separately tested.

## 3. Scope

### Required review functionality

- Detect and display all relevant working-tree changes:
  - staged changes;
  - unstaged changes;
  - untracked files;
  - additions, modifications, deletions, and renames;
  - mode-only changes, submodules, binary files, and oversized files as
    explicit non-text entries rather than silent omissions.
- Refresh the diff while the review is open.
- Show a file list and the selected file's unified diff.
- Navigate by file, hunk, and changed/context line.
- Show old and new line numbers.
- Highlight supported source languages with Tree-sitter.
- Select one line or a contiguous line range on either the old or new side.
- Create, edit, delete, list, and jump to saved comments.
- Clearly distinguish saved comments from the unfinished editor draft.
- Keep comments when the underlying diff refreshes.
- Mark comments as stale when they can no longer be anchored safely.
- Persist saved comments atomically by exact `reviewKey`.
- Restore comments after an unexpected pane exit or a deliberate close/reopen.
- Preserve the current cursor, selected file, selected hunk, and saved comments
  while the live pane is only hidden with `F6`.
- Export both anchored and stale saved comments through `F7`, with a visible
  stale-location warning and the original context.

### Explicit non-goals

- Full Hunk feature parity.
- AI-generated annotations, automated review findings, or agent-authored
  comments.
- Editing repository files from the review pane.
- Staging, unstaging, reverting, committing, or branch/ref management.
- GitHub/GitLab pull-request review APIs.
- `jj`, Sapling, or other non-Git VCS backends.
- Structural/semantic diffing.
- A public extension API for other reviewers.
- A theme marketplace or broad configuration system.
- A split diff in the first release.
- Windows support; the repository currently supports Linux and macOS.
- Renaming the repository or changing the legacy
  `quantick.hunk-review` plugin ID during this work.

## 4. Runtime and dependency architecture

Use two intentionally separate runtimes:

| Process | Runtime | Responsibility |
| --- | --- | --- |
| `src/open-review.mjs` | Node.js 18+ | Resolve the source agent/repository, open or move the pane, and maintain the association |
| native review pane | Bun | Run OpenTUI, Git refreshes, navigation, Tree-sitter, the comment editor, and persistence |
| `src/send-notes.mjs` | Node.js 18+ | Resolve the exact active review, load validated saved notes, format the prompt, and focus the agent |
| `src/herdr-api.mjs` | Node.js 18+ | Insert text through `pane.send_input` with `keys: []` |
| pure shared modules | Node.js 18+ and Bun | State schemas, validation, review selection, prompt formatting, and migrations |

OpenTUI must not be imported by a module used by the Node action processes.
This keeps Node.js 18 support independent of OpenTUI's native FFI runtime.

The only new production library planned for the first release is
`@opentui/core`. Any additional parser or UI dependency requires a concrete
operational benefit, a license check, and a comparison against a small local
implementation.

### Distribution gate

The development and first vertical slice may require Bun to be installed and
run the pane with a command equivalent to:

```sh
bun run src/review-pane.mjs
```

Before public cutover, prove one of these installation models end to end:

1. **Bun runtime model:** document Bun as a prerequisite and verify that a
   fresh Herdr plugin installation installs the exact locked OpenTUI dependency
   before the pane starts.
2. **Standalone model:** build and publish native Bun executables for Linux and
   macOS on x64 and arm64, include checksums, select the correct artifact
   without guessing, and smoke-test Tree-sitter assets inside every artifact.

Prefer the Bun runtime model for the first usable version unless Herdr's plugin
installation lifecycle cannot install dependencies reliably. Do not remove the
Hunk backend until a fresh-machine installation test succeeds with the chosen
model.

## 5. Proposed module boundaries

Keep UI, Git, persistence, and Herdr orchestration separate so most behavior can
be tested without a terminal:

```text
src/
  open-review.mjs           Node action; association and F6 pane toggle
  send-notes.mjs            Node action; F7 resolution and draft insertion
  herdr-api.mjs             Node Herdr socket client
  common.mjs                Runtime-neutral association and prompt helpers
  review-pane.mjs           Small Bun/OpenTUI entrypoint
  review/
    model.mjs               Normalized files, hunks, rows, positions, generations
    git-source.mjs          Read-only Git status/diff acquisition
    parse-diff.mjs          Patch parser and stable row identities
    anchors.mjs             Comment anchors and deterministic re-anchoring
    store.mjs               Versioned validation, atomic writes, migration
    languages.mjs           Filetype detection and Tree-sitter registry
    controller.mjs          Refresh, selection, editor, and command state machine
    ui.mjs                  OpenTUI layout and event bindings
```

The final names may change, but these boundaries should remain:

- the Git layer produces a normalized model and knows nothing about OpenTUI;
- the UI renders stable model row IDs and never invents source locations;
- the store accepts only validated human notes;
- `send-notes` reads the store and does not need a live UI session;
- Herdr association remains outside the review renderer.

## 6. Diff acquisition and normalized model

### Read-only Git rules

Run Git with argument arrays, never through a shell. Disable pagers, colors,
external diff drivers, and text conversion. Set `GIT_OPTIONAL_LOCKS=0` where
supported so polling does not create avoidable repository locks.

Use NUL-delimited status/name metadata for paths. Treat file paths and file
contents as untrusted terminal input: preserve valid Unicode but prevent
control sequences from being interpreted as UI commands.

The acquisition layer should:

1. Obtain a cheap status fingerprint.
2. Rebuild the patch only when that fingerprint changes or the user requests a
   manual refresh.
3. Compare the final working tree against `HEAD`, covering both staged and
   unstaged changes.
4. Handle an unborn repository by comparing against Git's empty tree.
5. Add untracked files as new-file diffs without adding them to the index.
6. Detect renames with a documented fixed threshold.
7. Emit explicit models for binary, submodule, mode-only, and too-large entries.

The parser must not infer a source line from screen coordinates. Every rendered
row receives a stable identity such as:

```text
file identity + hunk identity + row kind + old line + new line + occurrence
```

Each text row records:

- file identity and current/previous path;
- row kind: context, addition, deletion, or no-newline marker;
- old and new line number when present;
- exact unprefixed source text;
- hunk identity and order;
- diff generation;
- whether the row is commentable.

Path parsing, quoted paths, spaces, tabs, Unicode, renames, and `\ No newline at
end of file` require dedicated fixtures.

### Refresh behavior

- Poll approximately once per second initially; tune only after measuring.
- Run Git asynchronously so terminal input never waits on a subprocess.
- Allow at most one active refresh and one queued latest refresh.
- Tag results with a monotonically increasing generation and discard late
  results from older generations.
- Preserve the selected place by file/hunk/row identity, not by terminal row.
- While a comment is being composed, keep its original anchor stable and
  reconcile it only after save or cancel.
- If Git fails, retain the last valid diff and show an actionable, nonfatal
  status message.
- Establish and document patch/file limits during the technical spike. Start
  evaluation around 16 MiB total patch data and 2 MiB per text file; large
  entries must remain visible as skipped items instead of freezing the UI.

The implementation must prove with before/after assertions that status, index,
refs, and working-tree contents are unchanged by opening, refreshing,
commenting, hiding, and sending a review.

## 7. OpenTUI layout and interaction

Use a compact three-area layout:

```text
┌ files ─────────┬ unified diff ──────────────────────────────────┐
│ status + path  │ file header, hunks, old/new line numbers       │
│ note counts    │ selected row/range and saved-note indicators   │
├────────────────┴────────────────────────────────────────────────┤
│ status/help, or multiline comment editor when active            │
└─────────────────────────────────────────────────────────────────┘
```

For narrow panes, collapse the file list into a temporary overlay or a
single-line file selector. The comment editor must retain enough space to show
its save/cancel keys. Resize events must not lose focus, text, selection, or
the current anchor.

### Proposed key contract

The exact help text can be refined during the UX slice, but the first release
must provide a stable, documented contract:

- arrows or `j`/`k`: previous/next diff row;
- `[`/`]`: previous/next hunk;
- `{`/`}` or an equivalent discoverable pair: previous/next file;
- `v`: begin/end a contiguous range selection;
- `c`: comment on the current line or selected range;
- `e`: edit the comment at the current location;
- `d`: delete the selected saved comment with an explicit confirmation;
- `n`: open/close the saved-notes list;
- `r`: refresh immediately;
- `?`: show the complete in-pane help;
- `Esc`: cancel the current selection/editor/overlay before affecting the pane.

The editor must support multiline text, Unicode, normal paste and bracketed
paste, cursor movement, deletion, save, and cancel. Saving an empty or
whitespace-only note is rejected. Cancelling must leave the persisted store
unchanged.

Basic mouse support must cover:

- scrolling the file list and diff;
- choosing a file;
- choosing a commentable diff row;
- extending a range using a documented modifier or drag gesture;
- focusing and positioning the cursor in the comment editor.

Initial rendering should disable soft wrapping and use horizontal scrolling so
one model row has one visual row. Soft wrapping can be considered only after
source-line hit testing remains deterministic under tests.

### Diff renderer decision gate

Start the spike with OpenTUI's `DiffRenderable`, which already supplies unified
diff display, line numbers, and Tree-sitter integration. It does not expose a
complete public comment-selection API, so prove all of the following before
building the rest of the UI:

- keyboard selection maps to the correct old/new source line;
- mouse hit testing maps to the same model row;
- file and hunk headers do not shift the mapping unexpectedly;
- highlighting a selected row/range remains correct after refresh and resize;
- no private OpenTUI fields are required.

Maintain the normalized `DiffModel` independently even if `DiffRenderable` is
used.

If the mapping cannot be implemented against public APIs, stop that approach
early and build the diff viewport from OpenTUI `ScrollBox`, text/code
renderables, `TreeSitterClient`, and `SyntaxStyle`. Do not depend on private
OpenTUI parser or renderer fields. This gate must be resolved in the technical
spike, before comment persistence or F7 integration.

## 8. Tree-sitter highlighting

Tree-sitter highlighting is complete only when the rendered diff visibly uses
syntax spans, not merely when a parser package is installed.

The language layer must:

- map file names, extensions, and selected shebangs to stable filetype IDs;
- keep the mapping independent of the UI;
- package every required grammar WASM file and highlight query locally;
- explicitly configure the OpenTUI Tree-sitter data and worker paths;
- perform no network access when opening a review;
- cache parsers and highlighting results by file content/generation;
- show a quiet, nonfatal plain-text fallback for an unsupported language;
- show an actionable status for a required grammar that failed to load.

Minimum release language matrix:

- JavaScript, JSX, TypeScript, and TSX;
- JSON;
- Markdown;
- HTML and CSS;
- shell;
- Python;
- Go;
- Rust;
- YAML and TOML.

Additional grammars are welcome only when their runtime assets, licenses, and
tests are included. Deleted lines must be highlighted from the old-side source
and added lines from the new-side source; diff prefixes must not be parsed as
source code.

Tree-sitter worker/WASM/query packaging must be tested in the exact installed
artifact, not only from a development checkout. This is especially important
for a Bun standalone executable.

## 9. Human comment model

Persist a versioned native review document in the existing
`snapshots/<reviewKey>.json` location. A representative schema is:

```json
{
  "version": 2,
  "reviewKey": "uuid",
  "repository": "/absolute/repository/root",
  "updatedAt": "ISO-8601 timestamp",
  "ui": {
    "filePath": "src/example.mjs",
    "rowId": "stable model row identity"
  },
  "notes": [
    {
      "id": "uuid",
      "provenance": "human",
      "title": "",
      "body": "Saved review text",
      "anchor": {
        "path": "src/example.mjs",
        "previousPath": null,
        "side": "new",
        "startLine": 12,
        "endLine": 14,
        "selectedText": ["first line", "second line", "third line"],
        "contextBefore": ["preceding line"],
        "contextAfter": ["following line"],
        "contextHash": "content-derived fingerprint",
        "diffGeneration": 7
      },
      "status": "anchored",
      "createdAt": "ISO-8601 timestamp",
      "updatedAt": "ISO-8601 timestamp"
    }
  ]
}
```

The exact schema may be refined before coding, but it must retain:

- a generated immutable note ID;
- hard-coded `human` provenance that is not editable in the UI;
- repository-relative current and previous paths;
- old/new side;
- original line or contiguous range;
- selected text;
- small before/after context and a context fingerprint;
- created/updated timestamps;
- the originating diff generation;
- explicit anchored/stale status.

Validate every read and write:

- review key and repository must match the active association;
- paths must remain repository-relative and must not escape the repository;
- line/range bounds must be valid;
- note bodies must be nonempty and within explicit size limits;
- only `provenance: "human"` records may enter the F7 prompt;
- malformed records produce an actionable error rather than partial,
  unvalidated feedback.

Write the complete document to a mode-`0600` temporary sibling and atomically
rename it. Only saved notes go to disk. The live textarea buffer stays in
memory, so `F7` can never pick up an unfinished comment.

### Deterministic re-anchoring

On every new diff generation:

1. Match the same file identity, side, line/range, selected text, and context.
2. If that fails, use an exact context-hash match within the same file/side.
3. If that fails, accept an exact selected-text match only when it is unique in
   that file/side.
4. Use an explicit Git rename mapping when the old path moved to one new path.
5. Otherwise mark the note stale.

Do not use fuzzy text similarity or silently choose between multiple matches.
A stale note keeps its original location, text, and context; it remains
editable, deletable, visible in the notes list, and exportable by `F7` with a
stale warning.

## 10. Association, F6, and F7 behavior

### F6

Retain the existing association record:

- `reviewKey`;
- repository root;
- source agent pane and detected agent kind;
- review pane;
- Herdr workspace;
- opening timestamp.

Remove only the Hunk executable check and Hunk launch/session logic.

When the associated review pane is alive:

- visible review -> move the same pane to its background tab without focus;
- hidden review -> move the same pane beside the exact source agent and focus
  it;
- never terminate or recreate the process for hide/show.

When an old pane record is stale, ignore it. A replacement pane may reuse the
same `reviewKey` for the same agent and repository, so persisted comments can
be restored safely.

### F7 review selection

Replace newest-review guessing with uniqueness checks. Resolve in this order:

1. exact focused review pane;
2. exact focused source agent pane;
3. unique review matching both workspace and repository;
4. unique review matching the repository;
5. the only active review globally.

At each non-exact level, multiple candidates are an actionable ambiguity error.
Closed/stale Herdr pane records are inactive.

`send-notes` must:

- load the atomic native store by exact `reviewKey`;
- include only saved, validated, human-provenance notes;
- preserve the current 128 KiB generated-prompt limit;
- include file, old/new side, line/range, selected context, and stale status;
- focus the recorded source agent pane;
- insert through `pane.send_input` with `keys: []`;
- preserve existing agent input and leave the draft unsubmitted;
- report the number of inserted notes.

The default prompt template and its placeholders should remain compatible.
User-visible wording can change from “Hunk” to “review” without changing the
template contract.

## 11. Existing snapshot migration

Some installations may already have Hunk snapshots containing human notes.
The first native loader must support an idempotent v1-to-v2 migration:

1. Detect the old Hunk review envelope rather than treating it as corrupt v2.
2. Extract only note types/authors already recognized as human by the current
   `userNotesFromReview` rules.
3. Never migrate AI, agent, system, or unknown-provenance annotations.
4. Convert available path, side, line/hunk, text, and context fields.
5. Re-anchor against the current native `DiffModel`.
6. Preserve unlocatable human notes as stale notes instead of silently dropping
   them.
7. Write v2 atomically only after complete validation.
8. Preserve one untouched backup of the original v1 snapshot until migration
   and reload have both succeeded.

The migration logic belongs in a runtime-neutral module so both Bun and Node
tests can validate it. Corrupt or ambiguous legacy data must produce an
actionable message and leave the original file intact.

## 12. Implementation milestones

### Milestone 0 — Freeze contracts and fixtures

Tasks:

- Capture the current F6/F7 workflow in integration tests.
- Define the v2 review schema and validation limits.
- Define `DiffModel`, stable row identities, and old/new-side semantics.
- Create Git fixture repositories for all required change types.
- Record the current human-note filtering and prompt output as compatibility
  fixtures.

Exit criteria:

- The expected workflow and schemas can be reviewed without UI code.
- Tests fail for an agent-authored note entering the prompt.
- Tests fail when review resolution would guess between active candidates.

### Milestone 1 — OpenTUI, Bun, and Tree-sitter spike

Tasks:

- Pin Bun/OpenTUI development versions.
- Render a real repository diff inside a Herdr plugin pane.
- Load at least JavaScript and one WASM-backed second grammar.
- Verify keyboard input, mouse input, multiline paste, resize, and terminal
  cleanup.
- Resolve the `DiffRenderable` versus custom viewport decision gate.
- Prove both development checkout startup and the intended fresh-install path.

Exit criteria:

- A selected visual row maps deterministically to the expected file, side, and
  source line under keyboard, mouse, scroll, and resize.
- Tree-sitter colors appear in a captured styled frame.
- `SIGINT`, `SIGTERM`, normal exit, and renderer failure restore terminal state.
- No Node.js 18 action process imports OpenTUI.
- A documented packaging path is feasible; otherwise stop before a rewrite.

### Milestone 2 — Read-only live diff

Tasks:

- Implement status fingerprinting, patch acquisition, parsing, and generations.
- Add file/hunk/row navigation and responsive layouts.
- Add supported-language detection and the complete minimum grammar matrix.
- Implement manual and polling refresh with latest-generation-wins behavior.
- Add binary, submodule, mode-only, unsupported-language, and size-limit states.

Exit criteria:

- All Git fixtures render with correct paths and old/new line numbers.
- Staged, unstaged, and untracked changes appear together.
- Refresh preserves the logical selection or uses a documented nearest safe
  fallback.
- Git status, index, refs, and worktree hashes are unchanged after the suite.
- The UI remains responsive at the documented size limits.

### Milestone 3 — Native human comments

Tasks:

- Add line/range selection and the multiline editor.
- Add save, edit, delete, list, jump, note markers, and help.
- Implement atomic v2 storage and deterministic re-anchoring.
- Show stale notes and their original context.
- Restore persisted UI location and notes after pane restart.

Exit criteria:

- Only an explicit save changes the store.
- An unfinished or cancelled editor draft is absent from disk and F7.
- Refresh correctly keeps, moves, or marks every note stale without guessing.
- Concurrent F7 reads always see either the complete old or complete new store.
- Unicode and multiline notes survive save/reload exactly.

### Milestone 4 — Herdr integration and Hunk cutover

Tasks:

- Point the pane entrypoint to Bun/OpenTUI.
- Remove Hunk session discovery, polling, snapshot capture, and restoration.
- Update `open-review` and `send-notes` to use the native store.
- Add exact/unique review resolution.
- Implement and test legacy snapshot migration.
- Temporarily keep the old backend available only during development; delete it
  before release acceptance.

Exit criteria:

- The complete F6/F7 workflow works from the review pane, source agent, same
  repository, and unique-global-review cases.
- Ambiguous and stale review cases fail safely with useful stderr.
- Hiding/restoring retains the exact pane process, cursor, selection, editor
  state, and comments.
- F7 focuses the exact source agent, preserves existing input, inserts one
  structured draft, and never sends Enter.
- No runtime path invokes or requires `hunk`.

### Milestone 5 — Hardening, docs, and distribution

Tasks:

- Add basic mouse behavior, narrow-pane behavior, PTY tests, and performance
  budgets.
- Run Linux/macOS and x64/arm64 packaging/install smoke tests as applicable.
- Update `README.md`, `agent-guide.md`, manifest titles/descriptions, badges,
  setup prompts, troubleshooting, and in-pane key documentation.
- Remove the Hunk prerequisite and all user-facing claims that the pane is
  Hunk, while retaining legacy IDs for compatibility.
- Decide the SemVer bump from the actual compatibility impact and use the
  repository release procedure only when separately requested.

Exit criteria:

- A user can install the plugin on a clean supported machine using only the
  documented prerequisites.
- Required Tree-sitter assets load from the installed artifact without network
  access.
- Documentation describes the actual shortcuts, runtime, limitations, and
  recovery behavior.
- Search confirms that no active code or installation instruction depends on
  Hunk.
- All required checks pass.

## 13. Test strategy

### Pure Node/Bun unit tests

- patch parsing and stable row identities;
- old/new line mapping for every row kind;
- unusual and renamed paths;
- language detection;
- anchor validation and each deterministic re-anchoring step;
- stale and ambiguous anchors;
- store schema, size bounds, atomic-write failure handling, and migration;
- strict human provenance filtering;
- prompt formatting and the 128 KiB limit;
- exact/unique active-review selection.

### Temporary Git repository integration tests

Create isolated repositories for:

- staged-only, unstaged-only, and mixed changes;
- untracked files;
- new files in an unborn repository;
- rename plus edit;
- deletion;
- no-final-newline markers;
- executable/mode changes;
- symlinks;
- binary files;
- submodules;
- ignored files;
- Unicode, spaces, tabs, and quoting-sensitive paths;
- large generated files and total-patch limits.

Capture status, index tree, refs, and working-tree hashes before and after every
review action.

### OpenTUI headless tests under Bun

Use OpenTUI's testing renderer with fixed terminal dimensions to verify:

- normal and narrow layouts;
- styled snapshots with Tree-sitter spans;
- keyboard file/hunk/row navigation;
- mouse scroll, row selection, and editor focus;
- selected old/new source locations;
- range selection;
- add/edit/delete/save/cancel flows;
- multiline and bracketed paste;
- Unicode and wide-character cursor behavior;
- resize while browsing and editing;
- stale-note indicators and error/status messages.

Prefer semantic model assertions in addition to frame snapshots so harmless
rendering changes do not hide location bugs.

### PTY and Herdr integration tests

- start and stop the real Bun/OpenTUI pane in a pseudo-terminal;
- verify raw mode and cursor state are restored on all exits;
- simulate rapid refreshes and signals;
- use fake Herdr CLI/socket endpoints for pane open/move/list/focus and
  `pane.send_input`;
- assert `keys: []`, no Enter, and preservation of existing input;
- test multiple agents, repositories, workspaces, stale panes, and ambiguity;
- smoke-test the actual plugin manifest from a linked and a fresh installation.

### CI and required commands

Keep the repository's required command contract:

```sh
npm run version:check
npm test
npm run check
```

When implementation begins, update the scripts so `npm test` also runs the Bun
UI suite and `npm run check` validates Bun-specific source and packaged assets.
Pin Bun in CI while continuing the Node.js 18, 20, and 22 action test matrix.
Do not report the implementation complete while any required command fails.

## 14. Main risks and mitigations

| Risk | Mitigation |
| --- | --- |
| OpenTUI visual rows cannot be mapped through public APIs | Resolve this in Milestone 1; switch to a model-driven custom viewport without private APIs |
| OpenTUI 0.x changes break behavior | Exact dependency pin, committed lockfile, explicit upgrade PRs, headless and PTY tests |
| Tree-sitter worker/WASM files disappear during packaging | Explicit asset paths and installed-artifact smoke tests for every platform |
| Bun becomes only another undocumented global dependency | Declare and verify it, or ship tested standalone binaries before cutover |
| Refresh moves comments to the wrong code | Exact context/unique-match rules; otherwise mark stale, never fuzzy-guess |
| F7 reads a partial or unfinished comment | Atomic document replacement; editor draft remains memory-only |
| Multiple active reviews route feedback incorrectly | Exact association first, uniqueness at every fallback, actionable ambiguity errors |
| Git polling changes repository state or blocks input | Read-only flags, `GIT_OPTIONAL_LOCKS=0`, async processes, before/after invariants |
| Large/binary/generated diffs freeze the terminal | Explicit limits, metadata-only entries, async parsing, retained last valid frame |
| Legacy Hunk notes are lost | Idempotent migration, human-only extraction, backup before v2 replacement |
| Terminal paste/Unicode/resizing corrupts note text | Dedicated headless and PTY regression tests on Linux and macOS |

## 15. Definition of done

The Hunk dependency can be removed only when all of the following are true:

- `F6` opens, hides, and restores the correct live native review pane.
- Live staged, unstaged, and untracked changes are displayed correctly.
- Required languages have verified Tree-sitter highlighting.
- Keyboard and basic mouse diff navigation work.
- Human line/range comments can be saved, edited, deleted, restored, and
  re-anchored or marked stale.
- Unsaved drafts and non-human annotations cannot reach `F7`.
- `F7` resolves the exact review without guessing and inserts an editable,
  unsubmitted prompt into the exact source agent.
- Existing Hunk human-note snapshots migrate without silent loss.
- Review operations leave Git status, index, refs, and working-tree contents
  unchanged.
- Linux and macOS installation/runtime smoke tests pass for the selected
  distribution model.
- `README.md`, `agent-guide.md`, the manifest, and help text describe the native
  workflow and no longer require Hunk.
- `npm run version:check`, `npm test`, and `npm run check` all pass.

Release preparation, tagging, pushing, and publishing are intentionally outside
this plan execution and require a separate explicit request.
