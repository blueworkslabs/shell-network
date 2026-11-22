#!/usr/bin/env python3
"""Bounded diagnostic log retention; copy/truncate preserves open descriptors."""

import fcntl
import json
import os
import time
from pathlib import Path

HOME = Path.home()
STATE = HOME / ".local/state/t3-bridge"
LIMIT = 8 * 1024 * 1024
BUDGET = 128 * 1024 * 1024
KEEP = 3
AGE = 7 * 86400


def regular(path):
    """Only operate on ordinary, singly linked files owned by this user."""
    try:
        info = path.lstat()
        return (
            path.is_file()
            and not path.is_symlink()
            and info.st_uid == os.getuid()
            and info.st_nlink == 1
        )
    except FileNotFoundError:
        return False


def archive_path(source, generation):
    return Path(f"{source}.{generation}")


def rotate(sources):
    rotated = 0
    for source in sources:
        if source.stat().st_size <= LIMIT:
            continue
        for generation in range(KEEP, 0, -1):
            archive = archive_path(source, generation)
            if archive.exists():
                if not regular(archive):
                    raise RuntimeError("Unsafe rotation path")
                if generation == KEEP:
                    archive.unlink()
                else:
                    archive.replace(archive_path(source, generation + 1))

        descriptor = os.open(source, os.O_RDWR | os.O_NOFOLLOW)
        with os.fdopen(descriptor, "r+b") as current:
            size = os.fstat(current.fileno()).st_size
            current.seek(max(0, size - LIMIT))
            tail = current.read()
            if size > LIMIT:
                # Discard the partial first line at the retention boundary.
                tail = tail.partition(b"\n")[2]
            archive = archive_path(source, 1)
            output = os.open(
                archive,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                0o600,
            )
            with os.fdopen(output, "wb") as destination:
                destination.write(tail)
            current.truncate(0)
        rotated += 1
    return rotated


def expire(archives):
    pruned = 0
    for archive in archives:
        if regular(archive) and time.time() - archive.stat().st_mtime > AGE:
            archive.unlink()
            pruned += 1
    return pruned


def enforce_budget(sources, archives):
    total = sum(path.stat().st_size for path in sources + archives)
    pruned = 0
    for archive in sorted(archives, key=lambda path: path.stat().st_mtime):
        if total <= BUDGET:
            break
        total -= archive.stat().st_size
        archive.unlink()
        pruned += 1

    # Old provider diagnostics also count. Keep their inode for open writers.
    for source in sorted(sources, key=lambda path: path.stat().st_mtime):
        if total <= BUDGET:
            break
        descriptor = os.open(source, os.O_WRONLY | os.O_NOFOLLOW)
        try:
            total -= os.fstat(descriptor).st_size
            os.ftruncate(descriptor, 0)
        finally:
            os.close(descriptor)
        pruned += 1
    return pruned


def retain(sources):
    sources = [path for path in sources if regular(path)]
    rotated = rotate(sources)
    archives = [
        archive_path(source, generation)
        for source in sources
        for generation in range(1, KEEP + 1)
    ]
    pruned = expire(archives)
    archives = [path for path in archives if regular(path)]
    pruned += enforce_budget(sources, archives)
    return {
        "sources": len(sources),
        "rotated": rotated,
        "pruned": pruned,
        "bytes_after": sum(
            path.stat().st_size for path in sources + archives if regular(path)
        ),
        "budget_bytes": BUDGET,
    }


def main():
    STATE.mkdir(parents=True, exist_ok=True, mode=0o700)
    with open(STATE / "log-retention.lock", "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        sources = list(STATE.glob("*.jsonl")) + list(STATE.glob("*.log"))
        sources.append(HOME / ".local/state/t3-staging/server.log")
        provider_logs = HOME / ".local/state/t3-staging/data/userdata/logs/provider"
        sources += list(provider_logs.glob("*.log"))
        print(json.dumps(retain(sources)))


if __name__ == "__main__":
    main()
