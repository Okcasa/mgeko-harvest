#!/usr/bin/env python3
"""Pack the library's genuinely finished series into one lookup for the Worker.

The harvest (kunmanga, bato1) publishes no publication status: a card can say how
many chapters a title has and when the last one landed, but not whether the story
is over.  MangaDex does publish it -- completed / ongoing / hiatus / cancelled --
and its archive is already in the project (`output/mangadex.tsv` plus
`data/mangadex/meta.bin`, row-aligned).  This matches the harvest's titles
against that status and ships only the "completed" ones.

Matching is deliberately strict: the normalised title (and up to two alternate
names from the mangadex record) must hit exactly, the key has to be at least four
characters, and a key that two mangadex works disagree on is dropped rather than
guessed at.  Nothing here is inferred from dates or chapter counts.

Output `library/complete.bin` is a sorted list of FNV-1a/djb2 64-bit slug hashes,
so the Worker can answer "is this finished?" with a binary search over ~270 KB
instead of a title map.  Slugs do not move between crawls, so it stays valid as
the rows are rebuilt.

    python3 build_complete.py                  # rows from R2, write + print stats
    python3 build_complete.py --rows FILE      # a local rows.tsv instead
    python3 build_complete.py --upload         # also put the file in R2

The nightly harvest job packs the shelf first, so it passes the rows.bin it just
wrote; mangadex's own rows and meta are fetched from R2 when the repo does not
carry them.
"""

import argparse
import collections
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import unicodedata

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
MAGIC = b"MKCP"
VERSION = 1
MIN_KEY = 4
ALT_MIN_KEY = 6
STATUS_COMPLETE = "completed"
BUCKET = "mgeko-tags-data"
KEY = "library/complete.bin"
CACHE = os.path.join(HERE, ".cache", "complete")
DEX_TSV = os.path.join(ROOT, "output", "mangadex.tsv")
DEX_META = os.path.join(HERE, "data", "mangadex", "meta.bin")
OUT = os.path.join(HERE, "data", "library", "complete.bin")
WRANGLER = ["wrangler"] if shutil.which("wrangler") else ["npx", "wrangler@4"]


def clean(text):
    return re.sub(r"\s+", " ", str(text or "")).strip()


def title_key(text):
    text = unicodedata.normalize("NFKD", str(text or ""))
    text = text.encode("ascii", "ignore").decode("ascii").lower()
    text = re.sub(r"&amp;|&", " and ", text)
    return re.sub(r"[^a-z0-9]+", " ", text).strip()


def hash_pair(slug):
    """The Worker's hash: FNV-1a and djb2 over the slug's UTF-8 bytes."""
    data = slug.encode("utf-8")
    h1 = 2166136261
    h2 = 5381
    for byte in data:
        h1 = ((h1 ^ byte) * 16777619) & 0xFFFFFFFF
        h2 = (((h2 * 33) & 0xFFFFFFFF) ^ byte) & 0xFFFFFFFF
    return h1, h2


def fetch(key, dest):
    os.makedirs(CACHE, exist_ok=True)
    if not os.path.exists(dest):
        subprocess.run(WRANGLER + ["r2", "object", "get", BUCKET + "/" + key,
                                   "--remote", "--file", dest], check=True)
    return dest


def meta_ok(path):
    """A truncated download is worse than none: it reads as "no statuses"."""
    try:
        with open(path, "rb") as fh:
            return fh.read(4) == b"MKMT"
    except OSError:
        return False


def tsv_ok(path):
    """The shelf rows are one line per record, so a cut file loses its tail."""
    try:
        with open(path, "rb") as fh:
            fh.seek(-1, os.SEEK_END)
            return fh.read(1) in (b"\n", b"\r")
    except OSError:
        return False


def dex_inputs():
    """The mangadex rows and their meta: local copies when the tree has them
    (a laptop), otherwise the same two objects the Worker already serves."""
    if os.path.exists(DEX_TSV) and meta_ok(DEX_META):
        return DEX_TSV, DEX_META
    rows = fetch("mangadex/rows.bin", os.path.join(CACHE, "mangadex.tsv"))
    meta = fetch("mangadex/meta.bin", os.path.join(CACHE, "mangadex-meta.bin"))
    if not meta_ok(meta):
        print("mangadex meta.bin was incomplete; fetching it again", file=sys.stderr)
        os.remove(meta)
        meta = fetch("mangadex/meta.bin", meta)
    if not tsv_ok(rows):
        print("mangadex rows.bin was incomplete; fetching it again", file=sys.stderr)
        os.remove(rows)
        rows = fetch("mangadex/rows.bin", rows)
    return rows, meta


def dex_meta_records(path):
    with open(path, "rb") as fh:
        data = fh.read()
    if data[:4] != b"MKMT" or len(data) < 16:
        raise ValueError("not a mangadex meta.bin: " + path)
    _version, count, _payload = struct.unpack("<III", data[4:16])
    table_end = 16 + (count + 1) * 4
    if table_end > len(data):
        raise ValueError("truncated mangadex meta.bin: " + path)
    at = struct.unpack("<%dI" % (count + 1), data[16:table_end])
    for row in range(count):
        start = table_end + at[row]
        end = table_end + at[row + 1]
        if end <= start:
            yield row, None
            continue
        try:
            yield row, json.loads(data[start:end])
        except ValueError:
            yield row, None


def dex_status_map(tsv_path, meta_path):
    """title key -> 'completed' / 'ongoing' / ..., ambiguous keys dropped."""
    rows = [line.rstrip("\n").split("\t") for line in open(tsv_path, encoding="utf-8")]
    found = {}
    ambiguous = set()
    for index, record in dex_meta_records(meta_path):
        if index >= len(rows) or len(rows[index]) < 2:
            continue
        status = clean((record or {}).get("s")).lower()
        if not status:
            continue
        keys = [title_key(rows[index][1])]
        keys += [title_key(alt) for alt in ((record or {}).get("a") or [])]
        for key in keys:
            if len(key) < MIN_KEY:
                continue
            if key in found and found[key] != status:
                ambiguous.add(key)
            found.setdefault(key, status)
    for key in ambiguous:
        found.pop(key, None)
    return found, len(ambiguous)


def fetch_rows(dest):
    os.makedirs(CACHE, exist_ok=True)
    if not os.path.exists(dest):
        subprocess.run(WRANGLER + ["r2", "object", "get", BUCKET + "/library/rows.bin",
                                   "--remote", "--file", dest], check=True)
    return dest


def library_rows(path):
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            parts = line.rstrip("\n").split("\t")
            if len(parts) >= 2 and parts[0] and parts[1]:
                yield parts[0], parts[1]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--rows", help="library rows TSV (default: pull R2 library/rows.bin)")
    parser.add_argument("--out", default=OUT, help="complete.bin to write")
    parser.add_argument("--upload", action="store_true", help="upload to R2 after writing")
    parser.add_argument("--stats", action="store_true", help="print coverage, write nothing")
    args = parser.parse_args()

    tsv_path, meta_path = dex_inputs()
    statuses, ambiguous = dex_status_map(tsv_path, meta_path)
    status_counts = collections.Counter(statuses.values())
    print("mangadex keys %s (ambiguous dropped %s)" % (f"{len(statuses):,}", f"{ambiguous:,}"))
    print("mangadex status", dict(status_counts.most_common()))

    rows_path = args.rows or fetch_rows(os.path.join(CACHE, "library.tsv"))
    done = []
    matched = collections.Counter()
    total = 0
    for slug, title in library_rows(rows_path):
        total += 1
        status = statuses.get(title_key(title))
        if status:
            matched[status] += 1
        if status == STATUS_COMPLETE:
            done.append(slug)

    pairs = sorted({hash_pair(slug) for slug in done})
    print("rows %s  matched %s  completed %s  unique %s"
          % (f"{total:,}", f"{sum(matched.values()):,}", f"{len(done):,}", f"{len(pairs):,}"))
    if args.stats:
        return

    payload = bytearray(MAGIC)
    payload += struct.pack("<III", VERSION, len(pairs), len(done))
    for h1, h2 in pairs:
        payload += struct.pack("<II", h1, h2)
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "wb") as fh:
        fh.write(payload)
    print("wrote", args.out, f"{len(payload):,} bytes")

    if args.upload:
        subprocess.run(WRANGLER + ["r2", "object", "put", BUCKET + "/" + KEY,
                                   "--remote", "--file", args.out], check=True)
        print("uploaded", KEY)


if __name__ == "__main__":
    main()
