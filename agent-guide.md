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

## 2. Install

For GitHub:

```sh
herdr plugin install quantk/herdr-hunk
```

Herdr runs the reviewed manifest build command (`npm ci --omit=dev`) before it
registers the plugin. Do not register a checkout whose dependency install
failed.

For a local checkout:

```sh
cd "/absolute/path/to/herdr-hunk"
npm ci
herdr plugin link "$PWD" --enabled
```

Resolve the checkout path; never invent it. `plugin link` does not run build
commands, so install dependencies first.

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
2. Press `F6` to open the native working-tree review.
3. Navigate with `j`/`k`, `[`/`]`, and `{`/`}`.
4. Select a line/range with `v`, press `c`, and save with `Ctrl+S`.
5. Press `F6` to hide/restore the same live pane.
6. Press `F7` to insert validated saved comments into the exact source agent.
7. Review or edit the draft, then press Enter manually.

The plugin never submits, never clears existing agent input, excludes
unfinished comments, and refuses ambiguous review routing. Press `?` inside
the pane for the full keyboard/mouse reference.

## 6. Report

Finish with:

- detected Herdr, Bun, and Node.js versions;
- installed/enabled plugin state;
- configured keys;
- `herdr config check` and reload results;
- any remaining client reload or prerequisite action.
