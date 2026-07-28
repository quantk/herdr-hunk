import assert from "node:assert/strict";
import test from "node:test";
import {
  createUntrackedPatch,
  parseUnifiedDiff,
  unquoteGitPath,
} from "../src/review/parse-diff.mjs";
import { detectFiletype } from "../src/review/languages.mjs";
import { terminalSafeText } from "../src/review/model.mjs";

test("parseUnifiedDiff maps old/new lines and stable row identities", () => {
  const patch = [
    "diff --git a/src/a.js b/src/a.js",
    "index 1111111..2222222 100644",
    "--- a/src/a.js",
    "+++ b/src/a.js",
    "@@ -2,3 +2,4 @@ function value() {",
    " same",
    "-old",
    "+new",
    "+extra",
    " tail",
    "\\ No newline at end of file",
  ].join("\n");
  const first = parseUnifiedDiff(patch, { generation: 1 });
  const second = parseUnifiedDiff(patch, { generation: 2 });
  assert.deepEqual(
    first.files[0].rows.map(({ kind, oldLine, newLine, text }) => ({
      kind,
      oldLine,
      newLine,
      text,
    })),
    [
      { kind: "context", oldLine: 2, newLine: 2, text: "same" },
      { kind: "deletion", oldLine: 3, newLine: null, text: "old" },
      { kind: "addition", oldLine: null, newLine: 3, text: "new" },
      { kind: "addition", oldLine: null, newLine: 4, text: "extra" },
      { kind: "context", oldLine: 4, newLine: 5, text: "tail" },
      {
        kind: "no-newline",
        oldLine: null,
        newLine: null,
        text: "\\ No newline at end of file",
      },
    ],
  );
  assert.deepEqual(
    first.files[0].rows.map((row) => row.id),
    second.files[0].rows.map((row) => row.id),
  );
});

test("diff parsing handles quoted renames, binary and mode-only entries", () => {
  const patch = [
    'diff --git "a/old name.js" "b/new name.js"',
    "similarity index 100%",
    'rename from "old name.js"',
    'rename to "new name.js"',
    "diff --git a/image.png b/image.png",
    "Binary files a/image.png and b/image.png differ",
    "diff --git a/tool.sh b/tool.sh",
    "old mode 100644",
    "new mode 100755",
    "diff --git a/vendor/lib b/vendor/lib",
    "index 1111111..2222222 160000",
    "Submodule vendor/lib contains modified content",
    "diff --git a/deleted.txt b/deleted.txt",
    "deleted file mode 100644",
    "--- a/deleted.txt",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-gone",
  ].join("\n");
  const model = parseUnifiedDiff(patch);
  assert.deepEqual(
    model.files.map(({ path, previousPath, status, kind }) => ({
      path,
      previousPath,
      status,
      kind,
    })),
    [
      {
        path: "new name.js",
        previousPath: "old name.js",
        status: "renamed",
        kind: "metadata",
      },
      {
        path: "image.png",
        previousPath: null,
        status: "modified",
        kind: "binary",
      },
      {
        path: "tool.sh",
        previousPath: null,
        status: "modified",
        kind: "mode",
      },
      {
        path: "vendor/lib",
        previousPath: null,
        status: "modified",
        kind: "submodule",
      },
      {
        path: "deleted.txt",
        previousPath: null,
        status: "deleted",
        kind: "text",
      },
    ],
  );
  assert.equal(unquoteGitPath('"space\\tname"'), "space\tname");
  assert.equal(unquoteGitPath('"caf\\303\\251.js"'), "café.js");
});

test("untracked patch and language detection cover supported forms", () => {
  const model = parseUnifiedDiff(createUntrackedPatch("new file.py", "print('x')"));
  assert.equal(model.files[0].status, "added");
  assert.equal(model.files[0].path, "new file.py");
  assert.equal(model.files[0].rows[0].newLine, 1);
  assert.equal(detectFiletype("src/view.tsx"), "tsx");
  assert.equal(detectFiletype("script", "#!/usr/bin/env python3"), "python");
  assert.equal(detectFiletype("unknown.data"), undefined);
  assert.equal(terminalSafeText("safe\u001b[31m"), "safe␛[31m");
});
