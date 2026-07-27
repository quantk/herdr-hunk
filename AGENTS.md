# Repository instructions

These instructions apply to every file in this repository.

## Project

Herdr Hunk Review is a Herdr workflow plugin that:

- opens a live Hunk diff beside a detected coding agent;
- keeps one review associated with its source agent and Git repository;
- hides and restores the same live Hunk pane without losing session state;
- sends saved human review notes back to the correct agent.

The plugin is implemented with Node.js ES modules and declarative entries in
`herdr-plugin.toml`. It supports Linux and macOS.

## Repository layout

- `herdr-plugin.toml` — plugin identity, version, actions, and pane entrypoint.
- `src/open-review.mjs` — `F6` toggle action and review association.
- `src/review-pane.mjs` — live Hunk process and snapshot lifecycle.
- `src/send-notes.mjs` — `F7` review resolution and agent prompt delivery.
- `src/common.mjs` — shared state, matching, formatting, and version-independent
  helpers.
- `test/` — Node.js unit tests.
- `scripts/` — version consistency and release preparation commands.
- `.github/workflows/` — CI and tag-driven GitHub Release automation.
- `agent-guide.md` — end-user setup instructions for coding agents.

## Development rules

1. Preserve the association between a review, its source agent pane, and its
   Git repository.
2. Never send AI or unrelated agent annotations as human feedback.
3. Do not terminate the Hunk process when implementing hide/show behavior.
4. Treat stale Herdr pane records as inactive.
5. Avoid guessing between multiple active reviews. Prefer exact pane, agent,
   workspace, and repository matches.
6. Keep plugin actions non-interactive and report actionable errors on stderr.
7. Do not modify a user's Git working tree as part of review actions.
8. Keep the plugin dependency-free unless a dependency has a clear operational
   benefit.
9. Maintain compatibility with Node.js 18.
10. Update README and `agent-guide.md` whenever installation, shortcuts, or
    user-visible workflow behavior changes.

## Required checks

Run all checks after code, manifest, workflow, or release-script changes:

```sh
npm run version:check
npm test
npm run check
```

Do not report completion while a required check is failing. If a check cannot
run because of the environment, report that limitation explicitly.

## Versioning

The project follows Semantic Versioning:

- patch — backwards-compatible bug fixes;
- minor — backwards-compatible features;
- major — breaking behavior, configuration, or compatibility changes.

The canonical version must match in:

- `package.json`;
- `herdr-plugin.toml`;
- a release tag, when one is being created.

Check consistency with:

```sh
npm run version:check
```

Prepare a new stable version with:

```sh
npm run release:prepare -- X.Y.Z
```

The preparation script updates `package.json`, `package-lock.json` when
present, and `herdr-plugin.toml`. Review the resulting diff before committing.
Do not edit only one version field.

## Release procedure

Only prepare, tag, push, or publish a release when the user explicitly asks for
that action.

For a requested release:

1. Confirm the intended SemVer bump.
2. Update user-facing documentation for changed behavior.
3. Run `npm run release:prepare -- X.Y.Z`.
4. Run all required checks.
5. Review the complete diff and confirm that no unrelated changes are included.
6. Commit with `chore(release): vX.Y.Z`.
7. Create an annotated tag:

   ```sh
   git tag -a vX.Y.Z -m "vX.Y.Z"
   ```

8. Push the release commit and tag only when explicitly authorized:

   ```sh
   git push origin main
   git push origin vX.Y.Z
   ```

Pushing the tag triggers `.github/workflows/release.yml`, which checks version
consistency, runs tests and syntax checks, and creates a GitHub Release with
generated notes.

Never:

- move or overwrite an existing release tag;
- publish from a dirty working tree;
- skip failing tests to create a release;
- use a tag whose version differs from the manifest;
- create a GitHub Release manually before the tag workflow completes;
- push commits or tags without the user's authorization.

## Commit guidance

- Keep commits focused and describe user-visible intent.
- Use `feat:` for new behavior, `fix:` for bug fixes, `docs:` for
  documentation-only changes, and `chore(release):` for version releases.
- Do not amend, rebase, force-push, or rewrite published history unless the
  user explicitly requests it.
- Preserve unrelated user changes in a dirty working tree.

## Pull requests and CI

CI runs on pushes to `main` and on pull requests using Node.js 18, 20, and 22.
Before opening or updating a pull request, run the required checks locally.

When CI fails:

1. inspect the failing job and logs;
2. reproduce the failure locally when possible;
3. fix the underlying issue rather than weakening the workflow;
4. rerun the complete required check set.
