# Agent setup guide

Use this guide when a user asks you to install and configure Herdr Native
Review. Complete the setup on the user's machine instead of only describing
commands.

The legacy plugin ID remains `quantick.hunk-review`; Hunk itself is not a
dependency.

## Safety

1. Inspect before changing anything.
2. Preserve unrelated Herdr config and keybindings.
3. Never replace the complete `config.toml`.
4. Do not add duplicate `[[keys.command]]` entries.
5. Ask before choosing an OS package manager or replacing conflicting keys.
6. Do not open a test review or insert a test prompt into a running agent.

## 1. Inspect prerequisites

Run:

```sh
herdr --version
bun --version
node --version
git --version
herdr plugin list --json
```

Requirements:

- Herdr 0.7.0 or newer;
- Bun 1.3.14;
- Node.js 18 or newer;
- Git;
- Linux or macOS.

If a prerequisite is missing or incompatible, stop and explain exactly what is
needed. Do not install or upgrade it through an OS package manager without
approval.

Record any existing entry whose plugin ID is `quantick.hunk-review`, including
its version, enabled state, and local or GitHub source. Read
`~/.config/herdr/config.toml` when it exists and locate every assignment for
`f6` and `f7` before changing either the plugin or its shortcuts.

## 2. Install

If `quantick.hunk-review` is not installed, install it from GitHub:

```sh
herdr plugin install quantk/herdr-review
```

Herdr runs the reviewed manifest build command (`npm ci --omit=dev`) before it
registers the plugin. Do not register a checkout whose dependency install
failed.

For a new local checkout:

```sh
cd "/absolute/path/to/herdr-review"
npm ci
herdr plugin link "$PWD" --enabled
```

Resolve the checkout path; never invent it. `plugin link` does not run build
commands, so install dependencies first.

If the plugin is already installed, do not install or link a second copy.
Compare its source and version with the current repository manifest. Enable an
otherwise current disabled installation with:

```sh
herdr plugin enable quantick.hunk-review
```

The supported Herdr CLI has no separate `plugin update` command. Replacing an
older GitHub installation or switching between GitHub and local sources may
require `plugin uninstall` or `plugin unlink`, which can affect existing plugin
state. Explain the detected situation and get the user's approval before
replacing it; after approval, install or link the current source and verify that
the same plugin ID is registered only once.

Verify:

```sh
herdr plugin list
herdr plugin action list --plugin quantick.hunk-review
```

The actions are `open-review` and `send-notes`.

## 3. Configure shortcuts

Read `~/.config/herdr/config.toml` first and search all assignments for `f6`
and `f7`. If they are free, append:

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

Keep equivalent or alternative existing bindings. Ask the user when either
default conflicts.

## 4. Validate and reload

```sh
herdr config check
herdr server reload-config
```

Fix only problems introduced by this setup. An attached client may need
`Ctrl+B`, then `Shift+R`, or detach/attach.

## 5. Explain the workflow

1. Focus a detected coding agent in a Git repository.
2. Press `F6` to open the native review.
3. Choose `1` for current uncommitted work, `2` for everything since the
   branch diverged from its local main/master base, or `3` for the latest
   file-changing turn observed from this exact agent. Navigate with `j`/`k`,
   use `Ctrl+U`/`Ctrl+D` for half-page movement, and switch change blocks or
   files with `[`/`]` and `{`/`}`; toggle the file sidebar with `b` or drag
   its divider to resize it, and toggle long-row wrapping with `w`. Letter and
   bracket shortcuts also work from a Russian keyboard layout.
4. Select a line/range with `v`, press `c`, and save with `Ctrl+S`.
5. Press `F6` to hide/restore the same live pane.
6. Press `F7` to insert validated saved comments into the exact source agent.
7. Review or edit the draft, then press Enter manually.

The plugin never submits, never clears existing agent input, excludes
unfinished comments, and refuses ambiguous review routing. Saved comments are
shown inline beneath their diff range and are kept separate per review scope;
`F7` sends only the active scope. Last-turn tracking starts after the pane
observes an idle-to-working transition and freezes when that turn finishes.
Press `?` or `F1` inside the pane for the full keyboard/mouse reference. `s`
chooses the old/new target only for unchanged context lines; additions are
always new and deletions are always old. `Ctrl+C` closes the review pane
cleanly; `F6` can reopen it with saved comments, active scope, sidebar
visibility, and sidebar width intact.

## 6. Report

Finish with:

- detected Herdr, Bun, and Node.js versions;
- installed/enabled plugin state;
- configured keys;
- `herdr config check` and reload results;
- any remaining client reload or prerequisite action.
