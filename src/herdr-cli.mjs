import { spawnSync } from "node:child_process";
import {
  describeCommandFailure,
  parseCommandJson,
} from "./common.mjs";

export const HERDR_COMMAND_TIMEOUT_MS = 10_000;

export function runHerdr(herdr, args, { maxBuffer } = {}) {
  return spawnSync(herdr, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: maxBuffer ?? 4 * 1024 * 1024,
    timeout: HERDR_COMMAND_TIMEOUT_MS,
  });
}

export function getHerdrPane(herdr, paneId) {
  const result = runHerdr(herdr, ["pane", "get", paneId]);
  let response;
  if (result.stdout.trim()) {
    response = parseCommandJson(result.stdout, "herdr pane get");
  } else if (result.stderr.trim()) {
    try {
      response = JSON.parse(result.stderr);
    } catch {
      // Non-JSON stderr is reported below with the complete command failure.
    }
  }
  if (result.status !== 0) {
    if (response?.error?.code === "pane_not_found") return undefined;
    throw new Error(describeCommandFailure("herdr pane get", result));
  }
  const pane = response?.result?.pane;
  if (!pane?.pane_id) {
    throw new Error("herdr pane get did not return a pane.");
  }
  return pane;
}

export function listHerdrPanes(herdr) {
  const result = runHerdr(herdr, ["pane", "list"]);
  if (result.status !== 0) {
    throw new Error(describeCommandFailure("herdr pane list", result));
  }
  const response = parseCommandJson(result.stdout, "herdr pane list");
  const panes = response?.result?.panes;
  if (!Array.isArray(panes)) {
    throw new Error("herdr pane list did not return a pane list.");
  }
  return panes;
}
