import { createHighlighter } from "../src/review/highlighting.mjs";
import { REQUIRED_FILETYPES } from "../src/review/languages.mjs";

const samples = {
  javascript: "const value = 1",
  typescript: "const value: number = 1",
  tsx: "const view = <div>hello</div>",
  json: '{"value": 1}',
  markdown: "# Heading",
  html: "<div>hello</div>",
  css: ".item { color: red; }",
  bash: "if true; then echo ok; fi",
  python: "def value(): return 1",
  kotlin: "fun value(): Int = 1",
  java: "class Value { int value() { return 1; } }",
  go: "package main\nfunc main() {}",
  rust: "fn main() {}",
  yaml: "value: true",
  toml: 'value = "ok"',
};

const highlighter = await createHighlighter();
try {
  for (const filetype of REQUIRED_FILETYPES) {
    const result = await highlighter.client.highlightOnce(
      samples[filetype],
      filetype,
    );
    if (result.error || !result.highlights?.length) {
      throw new Error(
        `Installed Tree-sitter asset failed for ${filetype}: ${result.error ?? "no syntax spans"}`,
      );
    }
  }
} finally {
  await highlighter.destroy();
}

process.stdout.write(
  `Loaded ${REQUIRED_FILETYPES.length} installed Tree-sitter grammars.\n`,
);
