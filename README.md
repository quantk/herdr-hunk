<h1 align="center">Herdr Hunk Review</h1>

<p align="center">
  Review agent-authored changes in Hunk and send inline feedback back to the
  correct agent without leaving Herdr.
</p>

<p align="center">
  <a href="https://github.com/quantick/herdr-hunk/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/quantick/herdr-hunk/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/quantick/herdr-hunk/releases"><img alt="GitHub release" src="https://img.shields.io/github/v/release/quantick/herdr-hunk"></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
  <img alt="Herdr 0.7.0 or newer" src="https://img.shields.io/badge/Herdr-%E2%89%A5%200.7.0-6c5ce7">
  <img alt="Hunk 0.17.6 or newer" src="https://img.shields.io/badge/Hunk-%E2%89%A5%200.17.6-00b894">
  <img alt="Node.js 18 or newer" src="https://img.shields.io/badge/Node.js-%E2%89%A5%2018-339933">
  <img alt="Linux and macOS" src="https://img.shields.io/badge/platform-Linux%20%7C%20macOS-4b5563">
</p>

<p align="center">
  <a href="#installation">Installation</a> ·
  <a href="#agent-assisted-setup">Agent setup</a> ·
  <a href="#configure-keyboard-shortcuts">Configuration</a> ·
  <a href="#usage">Usage</a> ·
  <a href="#troubleshooting">Troubleshooting</a>
</p>

---

Herdr Hunk Review connects three parts of the coding workflow:

1. a coding agent running in a Herdr pane;
2. a live [Hunk](https://github.com/modem-dev/hunk) diff review;
3. the inline notes you want to send back to that exact agent.

The review follows working-tree changes in real time. A single shortcut toggles
the Hunk pane without terminating its session, so comments remain available
while the review is hidden.

## Features

- Opens a live Hunk review beside the focused coding agent.
- Associates every review with its source agent and Git repository.
- Toggles the same Hunk session between a visible split and a background tab.
- Preserves Hunk comments while the review is hidden.
- Sends only human review notes back to the agent.
- Resolves the correct review from the Hunk pane, source agent, or another pane
  in the same Git repository.
- Supports multiple agents, repositories, workspaces, and concurrent reviews.

## Requirements

Install these dependencies before installing the plugin:

| Dependency | Minimum version | Purpose |
| --- | ---: | --- |
| [Herdr](https://herdr.dev/) | 0.7.0 | Plugin host and terminal workspace |
| [Hunk](https://www.npmjs.com/package/hunkdiff) | 0.17.6 | Interactive diff review |
| [Node.js](https://nodejs.org/) | 18 | Plugin runtime |
| Git | Any recent version | Repository discovery and working-tree diff |

Supported platforms:

- Linux
- macOS

Check the installed versions:

```sh
herdr --version
hunk --version
node --version
git --version
```

Install Hunk globally if it is not already available:

```sh
npm install --global hunkdiff
```

## Installation

### Install from GitHub

After the repository is published, install it directly with Herdr:

```sh
herdr plugin install quantick/herdr-hunk
```

Confirm that the plugin is installed and enabled:

```sh
herdr plugin list
herdr plugin action list --plugin quantick.hunk-review
```

The action list should contain:

- `open-review` — toggle the Hunk review;
- `send-notes` — send human notes to the associated agent.

### Link a local checkout

Use `plugin link` when developing the plugin or running an unpublished
checkout:

```sh
git clone https://github.com/quantick/herdr-hunk.git
cd herdr-hunk
herdr plugin link "$PWD" --enabled
```

A linked plugin runs directly from the checkout. Source changes are picked up
by the next action invocation, so reinstalling is not necessary.

## Agent-assisted setup

Your coding agent can inspect the machine, install the plugin, and update the
existing Herdr configuration for you. Paste this prompt into Codex, Claude, or
another agent with terminal access:

```text
Set up Herdr Hunk Review on this machine.

Read and follow this guide first:
https://raw.githubusercontent.com/quantick/herdr-hunk/main/agent-guide.md

Inspect the existing environment and Herdr config before making changes.
Preserve unrelated settings, avoid duplicate keybindings, validate the final
config, reload it, and report exactly what was changed.
```

The guide instructs the agent to preserve the existing configuration, detect
shortcut conflicts, verify every dependency, and avoid sending test prompts to
running agents.

## Configure keyboard shortcuts

Herdr plugin manifests do not define or override global keybindings. Add the
shortcuts explicitly to the Herdr configuration file:

```text
~/.config/herdr/config.toml
```

Append the following entries:

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
description = "Send Hunk notes to agent"
```

Validate and reload the configuration:

```sh
herdr config check
herdr server reload-config
```

If an already attached client does not pick up the new shortcuts, press
`Ctrl+B`, release it, then press `Shift+R`, or detach and attach Herdr again.

The examples use `F6` and `F7`, but any valid Herdr key combination can be
used. Function keys are a reliable default because many terminals intercept
`Alt`-based combinations.

## Usage

### 1. Open a review

Focus a Herdr pane containing a detected coding agent inside a Git repository,
then press:

```text
F6
```

Hunk opens in a split beside the agent and watches the working-tree diff.

### 2. Add inline notes

Navigate to the relevant change in Hunk and press `c` to create a human note.
Use the controls shown in the note editor to save it. Press `?` in Hunk to see
the complete key reference.

Only saved human notes are sent. An unfinished draft is not included.

### 3. Hide or restore the review

Press `F6` again from either the source agent pane or its Hunk pane.

- When visible, the live Hunk pane moves to a background tab.
- When hidden, the same pane moves back beside the agent.

This is a true session-preserving toggle: the Hunk process, session ID, current
position, and comments remain alive.

Do not use Herdr's pane-close shortcut (`Ctrl+B`, then `x`) when you only want
to hide the review. That command terminates the pane.

### 4. Send notes to the agent

Press:

```text
F7
```

`F7` can be invoked from:

- the Hunk pane;
- the associated agent pane;
- another pane in the same Git repository;
- any pane, when only one Hunk review is running.

When multiple reviews are active and the current pane does not identify a
repository, focus the intended Hunk or source agent before pressing `F7`.

The plugin sends all saved human notes as one structured prompt containing the
repository, file paths, line or hunk locations, and note text. AI and agent
annotations are excluded. The generated prompt has a 128 KiB safety limit.

## How review association works

Each review records:

- the source agent pane;
- the Git repository root;
- the Herdr workspace and review pane;
- the exact live Hunk session.

This prevents feedback from one project from being sent to an agent in another
project. Stale state belonging to closed panes is ignored.

## Troubleshooting

### A shortcut does nothing

Check the Herdr configuration:

```sh
herdr config check
```

Then confirm that the plugin actions are registered:

```sh
herdr plugin action list --plugin quantick.hunk-review
```

Some terminals or desktop environments reserve function keys. If necessary,
replace `f6` and `f7` with unused Herdr key combinations.

### Herdr cannot find an agent

`F6` must initially be invoked from a pane containing an agent detected by
Herdr. Confirm detection with:

```sh
herdr agent list
```

The agent must be working inside a Git repository.

### “This review has no human notes”

The note must be saved in Hunk before pressing `F7`. Draft text is not included
in the Hunk session snapshot.

### Several reviews are running

Focus the intended Hunk pane, its source agent, or another pane inside the same
Git repository, then press `F7` again.

### Inspect plugin logs

```sh
herdr plugin log list --plugin quantick.hunk-review --limit 20
```

### Reset a local installation

Unlinking removes the Herdr registration but does not delete the checkout:

```sh
herdr plugin unlink quantick.hunk-review
herdr plugin link "$PWD" --enabled
```

For a GitHub-managed installation:

```sh
herdr plugin uninstall quantick.hunk-review
herdr plugin install quantick/herdr-hunk
```

## Development

Clone and link the repository:

```sh
git clone https://github.com/quantick/herdr-hunk.git
cd herdr-hunk
herdr plugin link "$PWD" --enabled
```

Run the tests and syntax checks:

```sh
npm test
npm run check
```

Useful development commands:

```sh
herdr plugin list
herdr plugin action list --plugin quantick.hunk-review
herdr plugin log list --plugin quantick.hunk-review --limit 20
```

## Releasing

The project follows [Semantic Versioning](https://semver.org/):

- patch (`0.1.0` → `0.1.1`) for backwards-compatible fixes;
- minor (`0.1.0` → `0.2.0`) for backwards-compatible features;
- major (`0.1.0` → `1.0.0`) for breaking changes.

The version is stored in both `package.json` and `herdr-plugin.toml`. Prepare a
release with:

```sh
npm run release:prepare -- 0.2.0
npm run version:check
npm test
npm run check
```

Review and commit the version change:

```sh
git add package.json package-lock.json herdr-plugin.toml
git commit -m "chore(release): v0.2.0"
```

If the repository has no `package-lock.json`, omit it from `git add`.

Create and push an annotated tag:

```sh
git tag -a v0.2.0 -m "v0.2.0"
git push origin main
git push origin v0.2.0
```

Pushing a `vX.Y.Z` tag starts the Release workflow. It verifies that the tag,
`package.json`, and `herdr-plugin.toml` contain the same version, runs the test
suite and syntax checks, then creates a GitHub Release with automatically
generated release notes.

The CI workflow runs the same version check, tests, and syntax checks for every
push to `main` and every pull request on Node.js 18, 20, and 22.

## Architecture

```text
F6 / open-review
    │
    ├── resolve the focused Herdr agent and Git repository
    ├── restore an existing live review, when present
    └── otherwise open a plugin-owned Hunk pane in watch mode

Hunk review pane
    │
    ├── follow working-tree changes
    ├── retain human inline notes
    └── publish snapshots to plugin state

F7 / send-notes
    │
    ├── resolve the matching live review
    ├── collect saved human notes
    └── prompt the associated Herdr agent
```

The plugin is implemented as out-of-process Node.js actions declared in
`herdr-plugin.toml`. It does not modify agent code, Git state, or repository
files.

## License

Released under the [MIT License](LICENSE).
