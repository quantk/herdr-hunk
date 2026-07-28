const FILETYPES = new Map([
  [".js", "javascript"],
  [".mjs", "javascript"],
  [".cjs", "javascript"],
  [".jsx", "javascript"],
  [".ts", "typescript"],
  [".mts", "typescript"],
  [".cts", "typescript"],
  [".tsx", "tsx"],
  [".json", "json"],
  [".jsonc", "json"],
  [".md", "markdown"],
  [".markdown", "markdown"],
  [".html", "html"],
  [".htm", "html"],
  [".css", "css"],
  [".scss", "css"],
  [".sh", "bash"],
  [".bash", "bash"],
  [".zsh", "bash"],
  [".py", "python"],
  [".go", "go"],
  [".rs", "rust"],
  [".yaml", "yaml"],
  [".yml", "yaml"],
  [".toml", "toml"],
]);

const BASENAMES = new Map([
  ["Dockerfile", "bash"],
  ["Makefile", "bash"],
  [".bashrc", "bash"],
  [".zshrc", "bash"],
]);

export const REQUIRED_FILETYPES = Object.freeze([
  "javascript",
  "typescript",
  "tsx",
  "json",
  "markdown",
  "html",
  "css",
  "bash",
  "python",
  "go",
  "rust",
  "yaml",
  "toml",
]);

export function detectFiletype(path, firstLine = "") {
  const name = path.split("/").at(-1) ?? path;
  if (BASENAMES.has(name)) return BASENAMES.get(name);
  const extensionIndex = name.lastIndexOf(".");
  const extension = extensionIndex >= 0 ? name.slice(extensionIndex).toLowerCase() : "";
  if (FILETYPES.has(extension)) return FILETYPES.get(extension);
  if (/^#!.*\b(?:ba|z|k)?sh\b/.test(firstLine)) return "bash";
  if (/^#!.*\bpython\d*\b/.test(firstLine)) return "python";
  if (/^#!.*\bnode\b/.test(firstLine)) return "javascript";
  return undefined;
}
