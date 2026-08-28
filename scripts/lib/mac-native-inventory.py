#!/usr/bin/python3
"""Emit NUL-framed kind/path pairs only after a complete native inventory."""
import os
import stat
import subprocess
import sys

# mach-o/{loader,fat}.h: thin/fat, 32/64-bit, both byte orders. Magic is only
# a prefilter: Java shares CAFEBABE, and file owns native/executable classification.
MAGICS = {bytes.fromhex(value) for value in (
    "feedface", "cefaedfe", "feedfacf", "cffaedfe",
    "cafebabe", "bebafeca", "cafebabf", "bfbafeca",
)}


def inventory(root):
    candidates = []
    records = []

    def visit(filename):
        mode = os.lstat(filename).st_mode
        if stat.S_ISLNK(mode):
            records.append((b"symlink", os.fsencode(filename)))
        elif stat.S_ISDIR(mode):
            with os.scandir(filename) as entries:
                for entry in sorted(entries, key=lambda entry: entry.name):
                    visit(entry.path)
        elif stat.S_ISREG(mode):
            # Never follow a substituted symlink or block on a substituted FIFO.
            fd = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            with os.fdopen(fd, "rb", buffering=0) as source:
                if not stat.S_ISREG(os.fstat(source.fileno()).st_mode):
                    raise ValueError(f"Inventory file changed type: {filename}")
                if source.read(4) in MAGICS:
                    candidates.append(filename)

    visit(root)
    # Bounded argv batches avoid both one process per file and ARG_MAX on macOS.
    for start in range(0, len(candidates), 64):
        batch = candidates[start:start + 64]
        result = subprocess.run(
            ["/usr/bin/file", "-E", "-b", "-0", "-0", "--", *batch],
            stdout=subprocess.PIPE,
        )
        result.check_returncode()
        descriptions = result.stdout.split(b"\0")
        if len(descriptions) != len(batch) + 1 or descriptions[-1] != b"":
            raise ValueError("Incomplete native classifier output")
        for filename, description in zip(batch, descriptions[:-1]):
            # Universal output embeds filenames on later architecture lines.
            # Those names must never grant executable entitlements to a library.
            first_line = description.split(b"\n", 1)[0]
            if not first_line or first_line.startswith(b"ERROR:"):
                raise ValueError(f"Native classification failed: {filename}")
            # file may not recognize fat64. Portability must still ask otool;
            # only file-classified native code is eligible for signing audits.
            kind = b"candidate"
            if first_line.startswith(b"Mach-O"):
                kind = b"executable" if b"executable" in first_line else b"library"
            records.append((kind, os.fsencode(filename)))
    return b"".join(kind + b"\0" + filename + b"\0" for kind, filename in records)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: mac-native-inventory.py <root>")
    sys.stdout.buffer.write(inventory(sys.argv[1]))
