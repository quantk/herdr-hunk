import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SyntaxStyle,
  TreeSitterClient,
  treeSitterToStyledText,
} from "@opentui/core";
import { REQUIRED_FILETYPES } from "./languages.mjs";

const assetRoot = fileURLToPath(
  new URL("../../assets/tree-sitter/", import.meta.url),
);

const BUNDLED = {
  javascript: {
    wasm: "javascript/tree-sitter-javascript.wasm",
    highlights: "javascript/highlights.scm",
  },
  typescript: {
    wasm: "typescript/tree-sitter-typescript.wasm",
    highlights: "typescript/highlights.scm",
  },
  markdown: {
    wasm: "markdown/tree-sitter-markdown.wasm",
    highlights: "markdown/highlights.scm",
  },
  tsx: {
    wasm: "tsx/tree-sitter-tsx.wasm",
    highlights: "typescript/highlights.scm",
  },
  json: {
    wasm: "json/tree-sitter-json.wasm",
    highlights: "json/highlights.scm",
  },
  html: {
    wasm: "html/tree-sitter-html.wasm",
    highlights: "html/highlights.scm",
  },
  css: {
    wasm: "css/tree-sitter-css.wasm",
    highlights: "css/highlights.scm",
  },
  bash: {
    wasm: "bash/tree-sitter-bash.wasm",
    highlights: "bash/highlights.scm",
  },
  python: {
    wasm: "python/tree-sitter-python.wasm",
    highlights: "python/highlights.scm",
  },
  kotlin: {
    wasm: "kotlin/tree-sitter-kotlin.wasm",
    highlights: "kotlin/highlights.scm",
  },
  java: {
    wasm: "java/tree-sitter-java.wasm",
    highlights: "java/highlights.scm",
  },
  go: {
    wasm: "go/tree-sitter-go.wasm",
    highlights: "go/highlights.scm",
  },
  rust: {
    wasm: "rust/tree-sitter-rust.wasm",
    highlights: "rust/highlights.scm",
  },
  yaml: {
    wasm: "yaml/tree-sitter-yaml.wasm",
    highlights: "yaml/highlights.scm",
  },
  toml: {
    wasm: "toml/tree-sitter-toml.wasm",
    highlights: "toml/highlights.scm",
  },
};

export function parserDefinitions() {
  return Object.entries(BUNDLED).map(([filetype, asset]) => ({
    filetype,
    wasm: join(assetRoot, asset.wasm),
    queries: {
      highlights: [
        join(assetRoot, asset.highlights),
      ],
    },
  }));
}

export async function createHighlighter() {
  const packageDirectory = dirname(
    fileURLToPath(import.meta.resolve("@opentui/core")),
  );
  const workerPath = join(packageDirectory, "parser.worker.js");
  const client = new TreeSitterClient({
    dataPath: assetRoot,
    workerPath,
  });
  for (const parser of parserDefinitions()) {
    client.addFiletypeParser(parser);
  }
  await client.initialize();

  const failed = [];
  for (const filetype of REQUIRED_FILETYPES) {
    if (!(await client.preloadParser(filetype))) failed.push(filetype);
  }
  if (failed.length) {
    await client.destroy();
    throw new Error(
      `Required Tree-sitter grammar failed to load: ${failed.join(", ")}`,
    );
  }

  const style = SyntaxStyle.fromStyles({
    variable: { fg: "#d8dee9" },
    keyword: { fg: "#c678dd", bold: true },
    string: { fg: "#98c379" },
    number: { fg: "#d19a66" },
    comment: { fg: "#7f848e", italic: true },
    function: { fg: "#61afef" },
    type: { fg: "#e5c07b" },
    property: { fg: "#56b6c2" },
    punctuation: { fg: "#abb2bf" },
  });
  const cache = new Map();
  return {
    client,
    style,
    async highlight(content, filetype, cacheKey = content) {
      if (!filetype) return content;
      const key = `${filetype}\0${cacheKey}`;
      if (!cache.has(key)) {
        cache.set(
          key,
          treeSitterToStyledText(content, filetype, style, client),
        );
      }
      return cache.get(key);
    },
    async destroy() {
      cache.clear();
      await client.destroy();
      style.destroy();
    },
  };
}
