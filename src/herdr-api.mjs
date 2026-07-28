import { createConnection } from "node:net";

export function insertPaneDraft(socketPath, paneId, text) {
  if (!socketPath) {
    throw new Error("HERDR_SOCKET_PATH is not set.");
  }

  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let response = "";
    let settled = false;

    const finish = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };

    socket.setEncoding("utf8");
    socket.setTimeout(5_000);
    socket.on("connect", () => {
      socket.write(
        `${JSON.stringify({
          id: `native-review:${process.pid}`,
          method: "pane.send_input",
          params: {
            pane_id: paneId,
            text,
            keys: [],
          },
        })}\n`,
      );
    });
    socket.on("data", (chunk) => {
      response += chunk;
      if (Buffer.byteLength(response, "utf8") > 1024 * 1024) {
        finish(new Error("Herdr API response exceeded 1 MiB."));
        return;
      }

      const newline = response.indexOf("\n");
      if (newline === -1) {
        return;
      }
      try {
        const parsed = JSON.parse(response.slice(0, newline));
        if (parsed?.error) {
          finish(
            new Error(
              parsed.error.message ??
                parsed.error.code ??
                "Herdr rejected pane input.",
            ),
          );
          return;
        }
        finish();
      } catch {
        finish(new Error("Herdr API returned invalid JSON."));
      }
    });
    socket.on("timeout", () => {
      finish(new Error("Herdr API timed out while inserting the draft."));
    });
    socket.on("error", (error) => {
      finish(new Error(`Cannot connect to the Herdr API: ${error.message}`));
    });
    socket.on("end", () => {
      if (!settled) {
        finish(new Error("Herdr API closed without a response."));
      }
    });
  });
}
