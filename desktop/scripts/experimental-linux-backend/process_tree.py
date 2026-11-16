"""Per-worker Linux child supervision; never select targets by executable name."""
import ctypes
import os
from pathlib import Path
import signal
import time


def enable_subreaper():
    # Verified against this host's /usr/include/linux/prctl.h.
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
        raise OSError(ctypes.get_errno(), 'Cannot supervise orphaned compiler children')


def read_process(pid):
    try:
        directory = Path('/proc') / str(pid)
        fields = (directory / 'stat').read_text().rsplit(')', 1)[1].split()
        return dict(pid=pid, parent=int(fields[1]), group=int(fields[2]), state=fields[0],
                    startTicks=int(fields[19]), command=(directory / 'comm').read_text().strip())
    except (OSError, ValueError, IndexError):
        return None


def descendants(root):
    processes = {}
    for entry in Path('/proc').iterdir():
        if entry.name.isdigit():
            record = read_process(int(entry.name))
            if record is not None:
                processes[record['pid']] = record
    found = []
    parents = {root}
    while parents:
        children = [item for item in processes.values() if item['parent'] in parents and item['pid'] != root]
        found.extend(children)
        parents = {item['pid'] for item in children}
    return found


def terminate_children():
    signalled = []
    for item in descendants(os.getpid()):
        current = read_process(item['pid'])
        if current is None or current['startTicks'] != item['startTicks'] or current['state'] == 'Z':
            continue
        try:
            os.kill(item['pid'], signal.SIGKILL)
            signalled.append(item['pid'])
        except ProcessLookupError:
            pass
    return signalled


def cleanup_children():
    # Call only after Popen.wait() has reaped the authoritative CLI child.
    deadline = time.monotonic() + 3
    reaped = []
    signalled = []
    while True:
        signalled.extend(terminate_children())
        while True:
            try:
                pid, _ = os.waitpid(-1, os.WNOHANG)
            except ChildProcessError:
                break
            if pid == 0:
                break
            reaped.append(pid)
        remaining = descendants(os.getpid())
        if not remaining or time.monotonic() >= deadline:
            return dict(reapedChildren=reaped, terminatedChildren=signalled, remainingChildren=remaining)
        time.sleep(0.02)
