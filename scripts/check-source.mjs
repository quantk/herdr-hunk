import { execFileSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
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

const manifest = readFileSync("herdr-plugin.toml", "utf8");
for (const required of [
  'id = "quantick.hunk-review"',
  'id = "open-review"',
  'id = "send-notes"',
  'id = "review"',
]) {
  if (!manifest.includes(required)) {
    throw new Error(`Missing required manifest entry: ${required}`);
  }
}
const commands = [...manifest.matchAll(/^command\s*=\s*(\[[^\n]+\])$/gm)]
  .map((match) => {
    try {
      return JSON.parse(match[1]);
    } catch {
      throw new Error(`Invalid manifest command: ${match[1]}`);
    }
  });
if (commands.length !== 4) {
  throw new Error(`Expected 4 manifest commands, found ${commands.length}.`);
}
for (const command of commands) {
  if (
    (command[0] === "node" || command[0] === "bun") &&
    (!command[1] || !existsSync(command[1]))
  ) {
    throw new Error(`Manifest command target does not exist: ${command[1]}`);
  }
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
