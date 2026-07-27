import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { insertPaneDraft } from "../src/herdr-api.mjs";

function listen(server, path) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

test("insertPaneDraft uses bracketed-paste-aware input without Enter", async () => {
  const socketPath = join(
    mkdtempSync(join(tmpdir(), "herdr-hunk-api-")),
    "herdr.sock",
  );
  let received;
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    let request = "";
    socket.on("data", (chunk) => {
      request += chunk;
      const newline = request.indexOf("\n");
      if (newline === -1) {
        return;
      }
      received = JSON.parse(request.slice(0, newline));
      socket.end(
        `${JSON.stringify({
          id: received.id,
          result: { status: "ok" },
        })}\n`,
      );
    });
  });

  await listen(server, socketPath);
  try {
    await insertPaneDraft(socketPath, "w1:p2", "line one\nline two");
  } finally {
    await close(server);
  }

  assert.equal(received.method, "pane.send_input");
  assert.deepEqual(received.params, {
    pane_id: "w1:p2",
    text: "line one\nline two",
    keys: [],
  });
});

test("insertPaneDraft reports Herdr API errors", async () => {
  const socketPath = join(
    mkdtempSync(join(tmpdir(), "herdr-hunk-api-error-")),
    "herdr.sock",
  );
  const server = createServer((socket) => {
    socket.once("data", () => {
      socket.end(
        `${JSON.stringify({
          id: "test",
          error: {
            code: "pane_not_found",
            message: "pane not found",
          },
        })}\n`,
      );
    });
  });

  await listen(server, socketPath);
  try {
    await assert.rejects(
      insertPaneDraft(socketPath, "missing", "draft"),
      /pane not found/,
    );
  } finally {
    await close(server);
  }
});
