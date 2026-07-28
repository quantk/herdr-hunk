#!/usr/bin/env python3
"""Exercise the real Bun/OpenTUI pane in a pseudo-terminal."""

import fcntl
import os
import pty
import select
import shutil
import signal
import struct
import subprocess
import tempfile
import termios
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
BUN = shutil.which("bun")
if not BUN:
    raise SystemExit("bun is required for the PTY smoke test")


def read_available(master: int, output: bytearray, timeout: float) -> None:
    ready, _, _ = select.select([master], [], [], timeout)
    if not ready:
        return
    try:
        output.extend(os.read(master, 65536))
    except OSError:
        pass


def run_signal_case(stop_signal: signal.Signals) -> None:
    with tempfile.TemporaryDirectory(prefix="herdr-review-pty-") as temporary:
        work = Path(temporary)
        repository = work / "repo"
        state = work / "state"
        repository.mkdir()
        state.mkdir()
        subprocess.run(
            ["git", "-C", str(repository), "init", "-q"],
            check=True,
        )
        (repository / "a.js").write_text(
            "const value = 1;\n",
            encoding="utf8",
        )

        master, slave = pty.openpty()
        fcntl.ioctl(
            slave,
            termios.TIOCSWINSZ,
            struct.pack("HHHH", 24, 100, 0, 0),
        )
        environment = {
            **os.environ,
            "TERM": os.environ.get("TERM", "xterm-256color"),
            "HERDR_HUNK_REPO": str(repository),
            "HERDR_HUNK_REVIEW_KEY": f"pty-{stop_signal.name.lower()}",
            "HERDR_PLUGIN_STATE_DIR": str(state),
        }
        process = subprocess.Popen(
            [BUN, "run", str(ROOT / "src/review-pane.mjs")],
            cwd=ROOT,
            env=environment,
            stdin=slave,
            stdout=slave,
            stderr=slave,
            start_new_session=True,
        )
        os.close(slave)
        output = bytearray()
        deadline = time.monotonic() + 12
        while b"unified diff" not in output and time.monotonic() < deadline:
            read_available(master, output, 0.1)
        if b"unified diff" not in output:
            os.killpg(process.pid, signal.SIGKILL)
            raise AssertionError(
                f"review pane did not render before {stop_signal.name}: "
                + output[-1000:].decode("utf8", "replace")
            )

        os.killpg(process.pid, stop_signal)
        try:
            exit_code = process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            raise AssertionError(
                f"review pane did not exit after {stop_signal.name}"
            )
        for _ in range(10):
            read_available(master, output, 0.05)
        os.close(master)

        if exit_code != 0:
            raise AssertionError(
                f"review pane exited {exit_code} after {stop_signal.name}: "
                + output[-1000:].decode("utf8", "replace")
            )
        for sequence in (
            b"\x1b[?1049h",
            b"\x1b[?1049l",
            b"\x1b[?25h",
            b"\x1b[?1000l",
            b"\x1b[?2004l",
        ):
            if sequence not in output:
                raise AssertionError(
                    f"missing terminal cleanup sequence {sequence!r} "
                    f"after {stop_signal.name}"
                )


for requested_signal in (signal.SIGINT, signal.SIGTERM):
    run_signal_case(requested_signal)

print("PTY signal and terminal-restoration smoke tests passed.")
