#!/usr/bin/env python3
"""Exercise the real Bun/OpenTUI pane in a pseudo-terminal."""

import errno
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
    except OSError as error:
        if error.errno != errno.EIO:
            raise


def prepare_test_process() -> None:
    signal.pthread_sigmask(
        signal.SIG_UNBLOCK,
        {signal.SIGINT, signal.SIGTERM},
    )
    signal.signal(signal.SIGINT, signal.SIG_DFL)
    signal.signal(signal.SIGTERM, signal.SIG_DFL)


def wait_for_exit(pid: int, timeout: float) -> int:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        waited, status = os.waitpid(pid, os.WNOHANG)
        if waited == pid:
            return os.waitstatus_to_exitcode(status)
        time.sleep(0.01)
    raise TimeoutError


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

        environment = {
            **os.environ,
            "TERM": os.environ.get("TERM", "xterm-256color"),
            "HERDR_HUNK_REPO": str(repository),
            "HERDR_HUNK_REVIEW_KEY": f"pty-{stop_signal.name.lower()}",
            "HERDR_HUNK_AGENT_PANE": "w1:p1",
            "HERDR_PLUGIN_STATE_DIR": str(state),
        }
        pid, master = pty.fork()
        if pid == 0:
            prepare_test_process()
            os.chdir(ROOT)
            os.execve(
                BUN,
                [BUN, str(ROOT / "src/review-pane.mjs")],
                environment,
            )
        fcntl.ioctl(
            master,
            termios.TIOCSWINSZ,
            struct.pack("HHHH", 24, 100, 0, 0),
        )
        output = bytearray()
        deadline = time.monotonic() + 12
        while b"1 working tree" not in output and time.monotonic() < deadline:
            read_available(master, output, 0.1)
        if b"1 working tree" not in output:
            os.killpg(pid, signal.SIGKILL)
            os.waitpid(pid, 0)
            raise AssertionError(
                f"review pane did not render before {stop_signal.name}: "
                + output[-1000:].decode("utf8", "replace")
            )

        if stop_signal == signal.SIGINT:
            os.write(master, b"\x03")
        else:
            os.killpg(pid, stop_signal)
        try:
            exit_code = wait_for_exit(pid, 10)
        except TimeoutError:
            os.killpg(pid, signal.SIGKILL)
            os.waitpid(pid, 0)
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
