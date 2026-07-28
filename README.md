<h1 align="center">Herdr Native Review</h1>

<p align="center">
  Review an agent's live Git working tree, save line comments, and draft the
  feedback into the exact source agent without leaving Herdr.
</p>

<p align="center">
  <a href="https://github.com/quantk/herdr-hunk/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/quantk/herdr-hunk/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/quantk/herdr-hunk/releases"><img alt="GitHub release" src="https://img.shields.io/github/v/release/quantk/herdr-hunk"></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
  <img alt="Herdr 0.7.0 or newer" src="https://img.shields.io/badge/Herdr-%E2%89%A5%200.7.0-6c5ce7">
  <img alt="Bun 1.3.14" src="https://img.shields.io/badge/Bun-1.3.14-f9f1e1">
  <img alt="Node.js 18 or newer" src="https://img.shields.io/badge/Node.js-%E2%89%A5%2018-339933">
  <img alt="Linux and macOS" src="https://img.shields.io/badge/platform-Linux%20%7C%20macOS-4b5563">
</p>

The repository and plugin ID retain the legacy `herdr-hunk` /
`quantick.hunk-review` names so existing installations and keybindings keep
working. The runtime no longer invokes or requires Hunk.

## Features

- Shows staged, unstaged, and untracked changes together in a unified diff.
- Represents renames, deletions, binaries, submodules, mode-only changes,
  symlinks, and oversized files without mutating Git state.
- Refreshes approximately once per second while preserving logical selection.
- Navigates files, hunks, and old/new source lines by keyboard and mouse.
- Highlights JavaScript, JSX, TypeScript, TSX, JSON, Markdown, HTML, CSS,
  shell, Python, Kotlin, Java, Go, Rust, YAML, and TOML with bundled
  Tree-sitter assets.
- Saves only explicit human comments; unfinished editor text stays in memory.
- Shows saved comment text inline beneath its anchored diff range.
- Re-anchors comments deterministically after refresh or marks them stale
  without guessing.
- Hides and restores the same live pane with `F6`.
- Inserts saved comments into the associated agent with `F7`, preserving
  existing input and never pressing Enter.
- Migrates legacy human Hunk notes once, preserving an untouched `.v1.bak`.

Review actions are strictly read-only with respect to Git. They do not stage,
unstage, revert, edit files, write refs, or create commits.

## Requirements

| Dependency | Version | Purpose |
| --- | ---: | --- |
| [Herdr](https://herdr.dev/) | 0.7.0+ | Plugin host and terminal workspace |
| [Bun](https://bun.sh/) | 1.3.14 | Native OpenTUI review pane |
| [Node.js](https://nodejs.org/) | 18+ | F6/F7 action processes and installation |
| Git | Recent | Read-only working-tree acquisition |

Supported platforms are Linux and macOS on x64 and arm64. Opening a review
performs no network access: OpenTUI and every required grammar, query, and WASM
asset are installed or bundled ahead of time.

## Installation

Install Bun, Node.js, Git, and Herdr first, then:

```sh
herdr plugin install quantk/herdr-hunk
herdr plugin list
herdr plugin action list --plugin quantick.hunk-review
```

Herdr previews and runs the manifest build command
`npm ci --omit=dev` before registering a GitHub installation. A failed
dependency install aborts cleanly.

For a local checkout:

```sh
git clone https://github.com/quantk/herdr-hunk.git
cd herdr-hunk
npm ci
herdr plugin link "$PWD" --enabled
```

`plugin link` intentionally does not run manifest build commands, so `npm ci`
is required before linking.

## Configure shortcuts

Add non-conflicting entries to `~/.config/herdr/config.toml`:

```toml
[[keys.command]]
key = "f6"
type = "plugin_action"
command = "quantick.hunk-review.open-review"
description = "Toggle native review"

[[keys.command]]
key = "f7"
type = "plugin_action"
command = "quantick.hunk-review.send-notes"
description = "Draft review notes for agent"
```

Then validate and reload:

```sh
herdr config check
herdr server reload-config
```

## Usage

Focus a detected coding agent inside a Git repository and press `F6`. The
native review opens beside that exact agent. Pressing `F6` again from the agent
or review moves the live pane to a background tab; another press restores the
same process and state.

The review pane uses this stable key contract:

| Keys | Action |
| --- | --- |
| arrows or `j` / `k` | Previous/next diff row |
| `[` / `]` | Previous/next separated change block |
| `{` / `}` | Previous/next file |
| `b` | Show/hide the file sidebar |
| `v` | Begin/end contiguous range selection |
| `s` | Choose old/new target for an unchanged context line |
| `c` | Comment on the selected line/range |
| `e` | Edit a saved comment at the current location |
| `d`, then `d` | Confirm deletion of a saved comment |
| `n` | Show/hide saved comments; arrows select and Enter jumps |
| `r` | Refresh immediately |
| `?` or `F1` | Show/hide help |
| `Esc` | Cancel editor, range, confirmation, or overlay |
| `Ctrl+S` | Save the active multiline comment |
| `Ctrl+C` | Close the review pane and restore the terminal |

Mouse wheel scrolling, file and row clicks, Shift-click range extension, drag
selection, and editor cursor placement are supported. Drag the vertical
divider to resize the file sidebar; its width is restored with the review.
Narrow panes initially collapse the file list; `b` shows or hides it without
losing the current file and row. Saved comment text is rendered inline beneath
its anchored diff range; `n` opens the complete saved-comments list, including
stale notes.

Letter and bracket shortcuts follow the physical QWERTY key position when the
terminal reports it and include a Russian-layout fallback. Text entered in the
comment editor is not remapped. The `s` target matters only for unchanged
context lines, which exist on both sides of a diff; additions always target
`new`, and deletions always target `old`.

Only a nonempty comment explicitly saved with `Ctrl+S` reaches disk. Cancelled
and unfinished comments cannot reach `F7`. Saved comments remain visible and
editable if their original location becomes stale.

Press `F7` from:

- the exact review pane;
- its source agent;
- a pane in the uniquely matching workspace/repository;
- a pane in the uniquely matching repository;
- anywhere when only one active review exists.

Every fallback must be unique. Ambiguous reviews produce an actionable error
instead of selecting the newest one. The structured draft includes file,
old/new side, line/range, selected context, stale warnings, and comment text.
The plugin focuses the recorded source agent and inserts the draft with
`keys: []`; it does not clear existing input or submit it.

## Prompt template

Create `prompt-template.md` in:

```sh
herdr plugin config-dir quantick.hunk-review
```

Use [the example](examples/prompt-template.md). Supported placeholders are:

- `{{repository}}` — absolute Git repository root;
- `{{notes}}` — numbered, structured saved comments;
- `{{note_count}}` — saved comment count.

`{{notes}}` is required. Unknown placeholders, an empty template, malformed
stores, non-human provenance, mismatched repositories/review keys, and drafts
larger than 128 KiB fail before any agent input is changed.

## Persistence and recovery

Each review is persisted atomically at
`HERDR_PLUGIN_STATE_DIR/snapshots/<reviewKey>.json` with mode `0600`. The v2
store validates the exact review/repository association, repository-relative
paths, old/new ranges, context hashes, timestamps, size limits, unique IDs,
and hard-coded `human` provenance.

If a pane is closed unexpectedly, reopening the same agent/repository reuses
its `reviewKey` and restores saved comments and the last selected location.
Legacy snapshots are migrated idempotently; only legacy note forms already
recognized as human are imported, and unlocatable notes become stale.

Limits are 64 KiB per comment, 500 comments per review, 2 MiB per text file,
16 MiB total patch data, and 128 KiB for the generated F7 draft. Large and
non-text entries stay visible as metadata instead of freezing the pane.

## Troubleshooting

- `F6` requires a Herdr-detected agent whose current directory is in a Git
  repository. Check `herdr agent list`.
- If the pane reports a Tree-sitter load failure, reinstall the plugin; all
  grammar assets must exist in the installed artifact.
- If several reviews match, focus the intended review or source agent.
- A saved note is required before `F7`; editor text alone is intentionally
  excluded.
- Inspect recent failures with
  `herdr plugin log list --plugin quantick.hunk-review --limit 20`.
- Validate shortcuts with `herdr config check`, then reload the server config.

## Development

```sh
npm ci
npm run version:check
npm test
npm run check
```

`npm test` runs runtime-neutral Node tests plus OpenTUI headless tests under the
exact Bun version. CI keeps Node.js 18, 20, and 22 coverage and smoke-tests a
fresh packed installation on Linux/macOS x64/arm64, including real PTY
SIGINT/SIGTERM cleanup and terminal restoration.

The runtime boundaries are:

```text
Node F6 action -> exact agent/repository association -> Bun/OpenTUI pane
                                                     -> read-only Git model
                                                     -> atomic human-note store
Node F7 action -> exact active review -> validated store -> unsubmitted draft
```

The review model, Git source, parser, anchors, store, language detection, and
controller remain independent of OpenTUI so their invariants can be tested
without a terminal.

## Release

Release preparation, tags, pushes, and publishing are separate explicit
actions. See `AGENTS.md` for the required SemVer and release procedure.

## License

Released under the [MIT License](LICENSE). Bundled grammar license notices are
kept under `assets/tree-sitter/`.
