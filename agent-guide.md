# Agent setup guide

Use this guide when a user asks you to install and configure Herdr Hunk Review.
Complete the setup on the user's machine instead of only describing the
commands.

## Goal

Leave the user with:

- Herdr 0.7.0 or newer;
- Node.js 18 or newer;
- Hunk 0.17.6 or newer;
- the `quantick.hunk-review` plugin installed and enabled;
- working shortcuts for toggling a review and drafting notes;
- a valid, reloaded Herdr configuration.

Supported platforms are Linux and macOS.

## Safety rules

1. Inspect before changing anything.
2. Preserve the user's existing Herdr configuration and unrelated keybindings.
3. Never replace the complete `config.toml` with a generated default.
4. Do not add duplicate `[[keys.command]]` entries.
5. Check whether the proposed keys are already assigned. If `F6` or `F7`
   conflicts with an existing binding, ask the user to choose alternatives.
6. Do not uninstall or upgrade unrelated software.
7. Report commands that fail instead of hiding the failure.

## 1. Inspect the environment

Run:

```sh
herdr --version
node --version
hunk --version
git --version
```

Also locate the Herdr configuration:

```sh
herdr --help
```

On Linux and macOS it normally lives at:

```text
~/.config/herdr/config.toml
```

If Herdr or Node.js is missing or older than the required version, stop and
explain which prerequisite the user needs to install. Do not select an
operating-system package manager without the user's approval.

If Hunk is missing or older than 0.17.6, install it with:

```sh
npm install --global hunkdiff
```

Verify the version again after installation.

## 2. Install the plugin

For the published GitHub repository:

```sh
herdr plugin install quantk/herdr-hunk
```

If the user is working from a local checkout instead:

```sh
herdr plugin link "/absolute/path/to/herdr-hunk" --enabled
```

Do not invent the local checkout path. Resolve it from the current workspace or
ask the user when it is unknown.

Verify the registration:

```sh
herdr plugin list
herdr plugin action list --plugin quantick.hunk-review
```

The action list must contain `open-review` and `send-notes`.

## 3. Configure shortcuts

Read the existing Herdr config before editing it. Search all existing
`[[keys.command]]` entries and other key assignments for `f6` and `f7`.

When the keys are free, add these entries without changing unrelated content:

```toml
[[keys.command]]
key = "f6"
type = "plugin_action"
command = "quantick.hunk-review.open-review"
description = "Toggle Hunk review"

[[keys.command]]
key = "f7"
type = "plugin_action"
command = "quantick.hunk-review.send-notes"
description = "Draft Hunk notes for agent"
```

If equivalent entries already exist, leave them unchanged. If the actions are
bound to different keys, keep the user's existing choices and report them.

## 4. Validate and reload

Run:

```sh
herdr config check
herdr server reload-config
```

Do not claim success if `herdr config check` reports unknown keys or invalid
values. Fix only problems introduced by this setup. Report unrelated existing
configuration warnings separately.

An attached Herdr client may need its client-side configuration reloaded. Tell
the user to press `Ctrl+B`, release it, then press `Shift+R`. Detaching and
reattaching Herdr is an alternative.

## 5. Explain the workflow

Tell the user:

1. Focus a detected coding agent inside a Git repository.
2. Press `F6` to open Hunk beside the agent.
3. Press `c` in Hunk to create and save inline human notes.
4. Press `F6` again to hide the live Hunk pane without terminating its session.
5. Press `F7` to insert the saved notes into the associated agent input.
6. Review or edit the draft, then press Enter to submit it yourself.

`F7` works from the Hunk pane, its source agent, another pane in the same Git
repository, or any pane when only one review is active.

The plugin does not submit the draft automatically and does not clear existing
agent input. It uses the English built-in prompt unless the user creates
`prompt-template.md` in the directory printed by:

```sh
herdr plugin config-dir quantick.hunk-review
```

The custom template must contain `{{notes}}`. It may also use
`{{repository}}` and `{{note_count}}`. Do not create a custom template unless
the user requests different wording.

Warn the user that Herdr's pane-close shortcut (`Ctrl+B`, then `x`) terminates
the Hunk pane. `F6` is the session-preserving hide/show toggle.

## 6. Final verification report

Finish with a concise report containing:

- the detected Herdr, Hunk, and Node.js versions;
- whether the plugin is installed and enabled;
- the configured keys;
- the result of `herdr config check`;
- whether configuration reload succeeded;
- any remaining manual action, such as reloading the attached client.

Do not open a review or insert a prompt into an agent merely as a setup test.
The user should trigger the first real review.
