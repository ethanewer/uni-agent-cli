#!/usr/bin/env python3
"""Race-safe project workflow discovery/read/save using POSIX dirfd operations."""

import json
import os
import secrets
import stat
import sys


MAX_SOURCE_BYTES = 256 * 1024


def require_secure_primitives():
    if not hasattr(os, "O_NOFOLLOW") or not hasattr(os, "O_DIRECTORY") or not hasattr(os, "O_NONBLOCK"):
        raise RuntimeError("secure directory-relative workflow I/O is unavailable on this platform")
    for operation in (os.open, os.mkdir, os.unlink):
        if operation not in os.supports_dir_fd:
            raise RuntimeError("secure directory-relative workflow I/O is unavailable on this platform")
    if os.listdir not in os.supports_fd:
        raise RuntimeError("secure directory-relative workflow discovery is unavailable on this platform")


def checked_directory(fd, label):
    info = os.fstat(fd)
    if not stat.S_ISDIR(info.st_mode):
        raise RuntimeError(f"{label} is not a directory")


def checked_owned_directory(fd, label):
    checked_directory(fd, label)
    info = os.fstat(fd)
    if hasattr(os, "getuid") and info.st_uid != os.getuid():
        raise RuntimeError(f"{label} is not owned by the current user")
    if info.st_mode & 0o022:
        raise RuntimeError(f"{label} is writable by another user")


def open_directory_at(parent_fd, name, label):
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(name, flags, dir_fd=parent_fd)
    checked_directory(fd, label)
    return fd


def ensure_directory_at(parent_fd, name, label):
    created = False
    try:
        os.mkdir(name, 0o700, dir_fd=parent_fd)
        created = True
    except FileExistsError:
        pass
    fd = open_directory_at(parent_fd, name, label)
    checked_owned_directory(fd, label)
    return fd, created


def open_absolute_directory(directory):
    absolute = os.path.abspath(directory)
    original_info = os.lstat(absolute)
    if stat.S_ISLNK(original_info.st_mode):
        raise RuntimeError("project root is a symlink")
    canonical = os.path.realpath(absolute)
    parts = [part for part in canonical.split(os.sep) if part]
    fd = os.open(os.sep, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    checked_directory(fd, "filesystem root")
    try:
        for index, part in enumerate(parts):
            next_fd = open_directory_at(fd, part, os.sep + os.path.join(*parts[: index + 1]))
            os.close(fd)
            fd = next_fd
        checked_owned_directory(fd, "project root")
        opened_info = os.fstat(fd)
        if (opened_info.st_dev, opened_info.st_ino) != (original_info.st_dev, original_info.st_ino):
            raise RuntimeError("workflow root changed while it was being opened")
        return fd, canonical
    except Exception:
        os.close(fd)
        raise


def write_all(fd, data):
    view = memoryview(data)
    while view:
        written = os.write(fd, view)
        if written <= 0:
            raise RuntimeError("project workflow write made no progress")
        view = view[written:]


def main():
    # The helper fails closed rather than treating absent no-follow/openat support
    # as an invitation to fall back to path-based workspace I/O.
    require_secure_primitives()
    operation = sys.argv[1] if len(sys.argv) > 1 else ""
    expected_arguments = 5 if operation == "save" else 4 if operation in ("read", "read-identity") else 3 if operation in ("list", "identity") else 0
    if len(sys.argv) != expected_arguments:
        raise RuntimeError("invalid secure project workflow helper invocation")
    if operation == "save":
        project_root, name, overwrite_value = sys.argv[2:]
    elif operation in ("read", "read-identity"):
        project_root, name = sys.argv[2:]
        overwrite_value = "0"
    else:
        project_root = sys.argv[2]
        name = ""
        overwrite_value = "0"
    if operation not in ("list", "identity") and (not name or any(character not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-" for character in name)):
        raise RuntimeError("invalid workflow name")
    source = b""
    if operation == "save":
        source = sys.stdin.buffer.read(MAX_SOURCE_BYTES + 1)
        if len(source) > MAX_SOURCE_BYTES:
            raise RuntimeError("workflow source exceeds the project save bound")
    overwrite = overwrite_value == "1"

    root_fd, canonical_root = open_absolute_directory(project_root)
    cc_fd = workflow_fd = file_fd = None
    temporary = f".{name}.{os.getpid()}.{secrets.token_hex(8)}.tmp"
    destination = f"{name}.js"
    try:
        root_info = os.fstat(root_fd)
        if operation == "identity":
            print(json.dumps({
                "canonicalRoot": canonical_root,
                "device": str(root_info.st_dev),
                "inode": str(root_info.st_ino),
            }, ensure_ascii=True, separators=(",", ":")))
            return
        if operation == "save":
            cc_fd, cc_created = ensure_directory_at(root_fd, ".cc", "project .cc directory")
            if cc_created:
                os.fsync(root_fd)
            workflow_fd, workflow_created = ensure_directory_at(cc_fd, "workflows", "project workflow directory")
            if workflow_created:
                os.fsync(cc_fd)
        else:
            cc_fd = open_directory_at(root_fd, ".cc", "project .cc directory")
            checked_owned_directory(cc_fd, "project .cc directory")
            workflow_fd = open_directory_at(cc_fd, "workflows", "project workflow directory")
            checked_owned_directory(workflow_fd, "project workflow directory")
        if operation == "list":
            names = sorted(
                entry for entry in os.listdir(workflow_fd)
                if entry.endswith(".js") and entry[:-3] and
                all(character in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-" for character in entry[:-3])
            )
            payload = json.dumps(names, ensure_ascii=True, separators=(",", ":")).encode("ascii")
            if len(payload) > MAX_SOURCE_BYTES:
                raise RuntimeError("project workflow discovery exceeds the output bound")
            sys.stdout.buffer.write(payload)
            return
        if operation in ("read", "read-identity"):
            flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
            file_fd = os.open(destination, flags, dir_fd=workflow_fd)
            info = os.fstat(file_fd)
            if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_SOURCE_BYTES:
                raise RuntimeError("workflow must be a bounded regular file")
            remaining = MAX_SOURCE_BYTES + 1
            chunks = []
            while remaining > 0:
                chunk = os.read(file_fd, min(65536, remaining))
                if not chunk:
                    break
                chunks.append(chunk)
                remaining -= len(chunk)
            payload = b"".join(chunks)
            if len(payload) > MAX_SOURCE_BYTES:
                raise RuntimeError("workflow source exceeds the project read bound")
            if operation == "read-identity":
                identity = json.dumps({
                    "canonicalRoot": canonical_root,
                    "device": str(root_info.st_dev),
                    "inode": str(root_info.st_ino),
                }, ensure_ascii=True, separators=(",", ":")).encode("ascii")
                sys.stdout.buffer.write(identity + b"\n")
            sys.stdout.buffer.write(payload)
            return
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
        file_fd = os.open(temporary, flags, 0o600, dir_fd=workflow_fd)
        write_all(file_fd, source)
        os.fsync(file_fd)
        os.close(file_fd)
        file_fd = None
        if overwrite:
            os.replace(temporary, destination, src_dir_fd=workflow_fd, dst_dir_fd=workflow_fd)
        else:
            os.link(temporary, destination, src_dir_fd=workflow_fd, dst_dir_fd=workflow_fd, follow_symlinks=False)
            os.unlink(temporary, dir_fd=workflow_fd)
        os.fsync(workflow_fd)
        print(json.dumps({"ok": True}))
    finally:
        if file_fd is not None:
            os.close(file_fd)
        if operation == "save" and workflow_fd is not None:
            try:
                os.unlink(temporary, dir_fd=workflow_fd)
            except FileNotFoundError:
                pass
        for fd in (workflow_fd, cc_fd, root_fd):
            if fd is not None:
                os.close(fd)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
