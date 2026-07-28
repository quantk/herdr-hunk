<h1 align="center">Herdr Native Review</h1>

<p align="center">
  Review an agent's live Git working tree, save line comments, and draft the
  feedback into the exact source agent without leaving Herdr.
</p>

<p align="center">
  <a href="https://github.com/quantk/herdr-review/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/quantk/herdr-review/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/quantk/herdr-review/releases"><img alt="GitHub release" src="https://img.shields.io/github/v/release/quantk/herdr-review"></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
  <img alt="Herdr 0.7.0 or newer" src="https://img.shields.io/badge/Herdr-%E2%89%A5%200.7.0-6c5ce7">
  <img alt="Bun 1.3.14" src="https://img.shields.io/badge/Bun-1.3.14-f9f1e1">
  <img alt="Node.js 18 or newer" src="https://img.shields.io/badge/Node.js-%E2%89%A5%2018-339933">
  <img alt="Linux and macOS" src="https://img.shields.io/badge/platform-Linux%20%7C%20macOS-4b5563">
</p>

The repository is `herdr-review`. The plugin ID retains the legacy
`quantick.hunk-review` name so existing installations and keybindings keep
working. The runtime no longer invokes or requires Hunk.

## Agent-assisted setup

**Recommended:** let a coding agent inspect the machine, install or link the
plugin, preserve the existing Herdr configuration, add non-conflicting
shortcuts, and validate the result.

Paste this prompt into Codex, Claude, or another agent with terminal access:

```text
Set up Herdr Native Review on this machine.

Read and follow this guide first:
https://raw.githubusercontent.com/quantk/herdr-review/main/agent-guide.md

Inspect the existing environment, installed Herdr plugins, and Herdr config
before making changes. Preserve unrelated settings, avoid duplicate plugin
installations and keybindings, validate the final config, reload it, and report
exactly what changed.
```

The guide requires the setup agent to ask before installing OS-level
dependencies or replacing conflicting keys or plugin installations. It also
prevents the agent from opening a test review or inserting test text into an
agent that is already running.

Prefer to perform each step manually? Continue with the requirements and
installation below.

## Features

- Switches between working-tree, branch, and last-observed-agent-turn diffs.
- Shows staged, unstaged, and untracked changes together in working-tree mode.
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
- Opens the live review in its own tab and toggles between review and agent
  tabs with `F6`.
- Inserts saved comments into the associated agent with `F7`, preserving
  existing input and never pressing Enter.
- Migrates legacy human Hunk notes once, preserving an untouched `.v1.bak`.

Review actions never stage, unstage, revert, edit files, move branches, or
create commits. Last-turn tracking snapshots through a throwaway index and
writes only plugin-private refs under `refs/herdr-hunk/`; the real index,
working tree, and branch refs are untouched.

## Requirements

| Dependency | Version | Purpose |
| --- | ---: | --- |
| [Herdr](https://herdr.dev/) | 0.7.0+ | Plugin host and terminal workspace |
| [Bun](https://bun.sh/) | 1.3.14 | Native OpenTUI review pane |
| [Node.js](https://nodejs.org/) | 18+ | F6/F7 action processes and installation |
| Git | Recent | Diff acquisition and private last-turn snapshots |

Supported platforms are Linux and macOS on x64 and arm64. Opening a review
performs no network access: OpenTUI and every required grammar, query, and WASM
asset are installed or bundled ahead of time.

## Installation

Install Bun, Node.js, Git, and Herdr first, then:

```sh
herdr plugin install quantk/herdr-review
herdr plugin list
herdr plugin action list --plugin quantick.hunk-review
```

Herdr previews and runs the manifest build command
`npm ci --omit=dev` before registering a GitHub installation. A failed
dependency install aborts cleanly.

For a local checkout:

```sh
git clone https://github.com/quantk/herdr-review.git
cd herdr-review
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
native review opens in a dedicated tab and Herdr switches to it immediately.
Press `F6` from that review tab to return to the exact source agent tab. Press
`F6` from the source agent again to switch back to the same live review
process and state. The pane is never moved into a split or restarted while
toggling. An already-running split review from an older release is moved once
into its dedicated tab without restarting the pane.

The review pane uses this stable key contract:

| Keys | Action |
| --- | --- |
| `1` / `2` / `3` | Working tree / branch / last observed turn |
| arrows or `j` / `k` | Previous/next diff row or detached comment |
| `gg` / `G` | First/last diff row in the current file |
| `Ctrl+U` / `Ctrl+D` | Move up/down by half a visible page |
| `[` / `]` | Previous/next separated change block |
| `{` / `}` | Previous/next file |
| `b` | Show/hide the file sidebar |
| `w` | Toggle wrapping of long diff rows |
| `v` | Begin/end contiguous range selection |
| `s` | Choose old/new target for an unchanged context line |
| `c` | Comment on the selected line/range |
| `e` | Edit a saved comment at the current location |
| `x` | Mark a saved comment resolved or reopen it |
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
stale notes. Press `w` to wrap long diff rows to the visible diff width; the
choice is restored with the review.

The active review scope is shown in the diff title and survives pane
hide/show or reopen:

- `1 working tree` compares `HEAD` with staged, unstaged, and untracked files.
- `2 branch` compares the merge-base of the local base branch and `HEAD` with
  the current working tree, so it includes committed branch work plus current
  uncommitted and untracked changes. The base is resolved locally from
  `origin/HEAD`, then `origin/main`, `main`, `origin/master`, or `master`;
  review never fetches.
- `3 last observed turn` compares snapshots taken at the beginning and end of
  the exact associated agent's latest observed file-changing turn. It shows a
  turn in progress and freezes when the agent returns to idle. Before a turn
  start is observed, it displays a waiting state.

Turn tracking samples `herdr agent list` once per refresh interval. A turn
shorter than that interval can be missed, and concurrent human edits during
the observed agent turn cannot be distinguished from agent edits. Commits
during the turn remain visible because the comparison is between worktree
trees rather than commit positions.

Letter and bracket shortcuts follow the physical QWERTY key position when the
terminal reports it and include a Russian-layout fallback. Text entered in the
comment editor is not remapped. The `s` target matters only for unchanged
context lines, which exist on both sides of a diff; additions always target
`new`, and deletions always target `old`.

Only a nonempty comment explicitly saved with `Ctrl+S` reaches disk. Cancelled
and unfinished comments cannot reach `F7`. Every new comment starts open.
Pressing `F7` does not resolve it because the action inserts a draft without
knowing whether the user submits it. Use `x` at an inline comment or in the
`n` list to mark it resolved; use `x` again to reopen it. Editing a resolved
comment also reopens it.

Open comments whose original code can no longer be anchored remain visible as
detached comment cards and in the `n` list. When their former selected text has
one exact location in the current diff, the card stays beneath that text,
including when it now appears as a deletion. Missing or ambiguous text uses a
bottom-of-diff fallback. Detached cards participate in `j`/`k` navigation and
support the same `e`, `x`, and `d d` actions. Resolved comments remain in the
saved history with a muted marker instead of being deleted. Comments are
isolated by scope; last-turn comments are additionally tied to that exact turn
baseline. `F7` inserts only open saved human comments from the currently active
scope, so resolved feedback is not repeated.

Press `F7` from:

- the exact review pane;
- its source agent;
- a pane in the uniquely matching workspace/repository;
- a pane in the uniquely matching repository;
- anywhere when only one active review exists.

Every fallback must be unique. Ambiguous reviews produce an actionable error
instead of selecting the newest one. The structured draft includes file,
old/new side, line/range, selected context, detached warnings, and comment
text. Before insertion, the plugin verifies that the recorded pane is still the
same detected agent in the same workspace and Git repository. If the pane was
reused or the agent moved to another repository, `F7` refuses to route stale
feedback. Otherwise it focuses the recorded source agent and inserts the draft
with `keys: []`; it does not clear existing input, submit it, or change comment
resolution state.

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
`HERDR_PLUGIN_STATE_DIR/snapshots/<reviewKey>.json` with mode `0600`. The v3
store validates the exact review/repository association, repository-relative
paths, scope and turn identity, old/new ranges, context hashes, timestamps,
size limits, unique IDs, and hard-coded `human` provenance. Existing v2
snapshots migrate to working-tree scope with an untouched `.v2.bak`.

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
- If `F7` reports that the source agent moved, focus that agent and press `F6`
  to open the review associated with its current repository.
- If another review action is already running, wait for it to finish and retry.
- A saved note is required before `F7`; editor text alone is intentionally
  excluded.
- `3 last observed turn` waits until this live review observes the associated
  agent transition from idle to working and change at least one file.
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
