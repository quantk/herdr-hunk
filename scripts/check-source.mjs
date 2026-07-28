import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { REQUIRED_FILETYPES } from "../src/review/languages.mjs";

function filesUnder(directory, suffix) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return filesUnder(path, suffix);
    return path.endsWith(suffix) ? [path] : [];
  });
}

for (const path of filesUnder("src", ".mjs")) {
  execFileSync(process.execPath, ["--check", path], { stdio: "inherit" });
}
for (const filetype of REQUIRED_FILETYPES) {
  const directory = join("assets", "tree-sitter", filetype);
  const wasm = readdirSync(directory).find((name) => name.endsWith(".wasm"));
  if (!wasm || statSync(join(directory, wasm)).size === 0) {
    throw new Error(`Missing Tree-sitter WASM asset for ${filetype}.`);
  }
  const query = join(
    "assets",
    "tree-sitter",
    filetype === "tsx" ? "typescript" : filetype,
    "highlights.scm",
  );
  if (statSync(query).size === 0) {
    throw new Error(`Missing Tree-sitter highlight query for ${filetype}.`);
  }
}
