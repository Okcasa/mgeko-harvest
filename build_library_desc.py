#!/usr/bin/env python3
"""Fill the harvest shelf's missing descriptions from the other two catalogues.

The library shelf (kunmanga + bato + comick) ships no synopsis of its own, while
mangadex and mangaupdates already in R2 carry one per title.  A lot of the same
stories appear in both, so this walks the library rows in their packed order and
writes a `meta.bin` beside them: a title page (and the app's sheet) then reads
its own record with one ranged GET, exactly like the other shelves.

The record is only written when a real synopsis was found -- boilerplate such as
"No synopsis has been added for this manga yet." does not count -- and a title
that normalises the same as two different archive entries is skipped rather
than guessed at.

    python3 build_library_desc.py                       # data/library/*
    python3 build_library_desc.py --rows /tmp/rows.tsv --out /tmp/meta.bin
    python3 build_library_desc.py --fetch               # pull the archives from R2
    python3 build_library_desc.py --stats               # coverage, write nothing

Rows must be the packed `library/rows.bin` order: `meta.bin` is looked up by row
index, so a rebuild has to follow whichever rows.bin was just uploaded.
"""

import argparse
import array
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

META_MAGIC = b"MKMT"
DESC_CAP = 1400
# a three-character title like "1999" or "!" says nothing about which work it
# is; matching those across catalogues produces confident nonsense
MIN_KEY = 4
BOILERPLATE = (
    "no synopsis has been added",
    "no description available",
    "no description has been added",
    "no summary available",
)

BUCKET = "mgeko-tags-data"
ARCHIVES = {
    # key in R2 -> local file candidates, newest catalogue first
    "mangadex": ["mangadex/rows.bin", "output/mangadex.tsv"],
    "mangaupdates": ["mangaupdates/rows.bin", "output/mangaupdates.tsv"],
}
# mangadex stores alternate titles in meta.bin; they catch the harvest's spelling
# of a title whose primary name differs (quotes, slashes, a subtitle).  Only the
# first two alts are kept per record, so this is a bonus pass, not the main one.
DEX_META_KEY = "mangadex/meta.bin"
ALT_MIN_KEY = 6
WRANGLER = ["wrangler"] if shutil.which("wrangler") else ["npx", "wrangler@4"]


def clean(text):
    return re.sub(r"\s+", " ", str(text or "")).strip()


def shorten(text, cap=DESC_CAP):
    text = clean(text)
    if len(text) <= cap:
        return text
    cut = text[:cap]
    space = cut.rfind(" ")
    return (cut[:space] if space > cap * 0.6 else cut).rstrip(",;: ") + "\u2026"


def title_key(text):
    """Comparison key: accents folded, case and punctuation ignored."""
    folded = unicodedata.normalize("NFKD", str(text or "")).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "", folded.lower())


def real_synopsis(text):
    text = clean(text)
    if len(text) < 40:
        return False
    low = text.lower()
    return not any(mark in low for mark in BOILERPLATE)


def find_local(name, key):
    candidates = []
    for base in (HERE, ROOT):
        for rel in ARCHIVES[name]:
            if rel.startswith("output/"):
                candidates.append(os.path.join(base, rel))
            candidates.append(os.path.join(base, "..", rel))
    for path in candidates:
        if os.path.isfile(path) and os.path.getsize(path) > 0:
            return path
    return None


def fetch_object(key, dest):
    """Download one R2 object; a partial file is never left behind."""
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    partial = dest + ".part"
    done = subprocess.run(
        WRANGLER + ["r2", "object", "get", f"{BUCKET}/{key}", "--file", partial, "--remote"],
        cwd=HERE, capture_output=True, text=True,
    )
    if done.returncode != 0 or not os.path.isfile(partial) or os.path.getsize(partial) == 0:
        detail = (done.stderr or done.stdout or "").strip().splitlines()
        print(f"  ! {key}: {detail[-1] if detail else 'download failed'}", file=sys.stderr)
        if os.path.exists(partial):
            os.remove(partial)
        return False
    os.replace(partial, dest)
    return True


def fetch_archive(name, dest_dir):
    """Download the archive's rows from R2, which is always the freshest copy."""
    dest = os.path.join(dest_dir, name + ".tsv")
    if os.path.isfile(dest) and os.path.getsize(dest) > 0:
        return dest
    return dest if fetch_object(ARCHIVES[name][0], dest) else None


def load_rows(path):
    with open(path, encoding="utf-8", errors="replace") as fh:
        return [line.rstrip("\n") for line in fh if line.strip()]


def load_archive(name, path):
    """title key -> (synopsis, type, year), skipping ambiguous and empty ones.

    Both TSVs put the synopsis last; a stray tab inside it makes the line one
    field longer, so everything from the known column on is joined back.
    """
    if name == "mangadex":
        type_at, year_at, desc_at = 3, 4, 5
    else:
        type_at, year_at, desc_at = 4, 5, 7
    found = {}
    ambiguous = set()
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            parts = line.rstrip("\n").split("\t")
            if len(parts) <= desc_at:
                continue
            key = title_key(parts[1])
            if len(key) < MIN_KEY:
                continue
            synopsis = clean("\t".join(parts[desc_at:]))
            if not real_synopsis(synopsis):
                continue
            entry = (shorten(synopsis), clean(parts[type_at])[:12], clean(parts[year_at])[:4])
            if key in found and found[key][0] != entry[0]:
                ambiguous.add(key)
            found[key] = entry
    for key in ambiguous:
        found.pop(key, None)
    return found, len(ambiguous)


def load_alt_titles(path):
    """mangadex alt title key -> (synopsis, the alt that matched).

    A key shared by two different works' alts is dropped rather than guessed at:
    alternate titles are short and generic far more often than primary ones.
    """
    with open(path, "rb") as fh:
        data = fh.read()
    if data[:4] != META_MAGIC or len(data) < 16:
        raise ValueError("not a meta.bin: " + path)
    _version, count, _payload = struct.unpack("<III", data[4:16])
    table_end = 16 + (count + 1) * 4
    if table_end > len(data):
        raise ValueError("truncated meta.bin: " + path)
    at = struct.unpack("<%dI" % (count + 1), data[16:table_end])
    found = {}
    ambiguous = set()
    for row in range(count):
        start = table_end + at[row]
        end = table_end + at[row + 1]
        if end <= start:
            continue
        try:
            record = json.loads(data[start:end])
        except ValueError:
            continue
        synopsis = clean(record.get("d"))
        if not real_synopsis(synopsis):
            continue
        for title in record.get("a") or []:
            key = title_key(title)
            if len(key) < ALT_MIN_KEY:
                continue
            if key in found and found[key][0] != shorten(synopsis):
                ambiguous.add(key)
            found.setdefault(key, (shorten(synopsis), clean(title)))
    for key in ambiguous:
        found.pop(key, None)
    return found, len(ambiguous)


def write_meta(path, records):
    at = array.array("I")
    payload = bytearray()
    for record in records:
        at.append(len(payload))
        if record is not None:
            payload += json.dumps(record, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    at.append(len(payload))
    header = META_MAGIC + struct.pack("<III", 1, len(records), len(payload))
    tmp = path + ".tmp"
    with open(tmp, "wb") as fh:
        fh.write(header)
        fh.write(at.tobytes())
        fh.write(bytes(payload))
    os.replace(tmp, path)
    return len(header) + (len(records) + 1) * 4 + len(payload)


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--rows", default=os.path.join(HERE, "data", "library", "rows.bin"),
                        help="packed library rows, in shelf order")
    parser.add_argument("--out", default=os.path.join(HERE, "data", "library", "meta.bin"),
                        help="meta.bin to write")
    parser.add_argument("--dex", help="mangadex rows TSV")
    parser.add_argument("--mu", help="mangaupdates rows TSV")
    parser.add_argument("--dex-meta", help="mangadex meta.bin, for alternate titles")
    parser.add_argument("--fetch", action="store_true",
                        help="download the archives from R2 when no local copy exists")
    parser.add_argument("--stats", action="store_true", help="report coverage, write nothing")
    args = parser.parse_args()

    rows = load_rows(args.rows)
    if not rows:
        print("no library rows at " + args.rows, file=sys.stderr)
        return 1
    print(f"library rows: {len(rows):,}")

    dex_path = args.dex or find_local("mangadex", None)
    mu_path = args.mu or find_local("mangaupdates", None)
    cache = os.path.join(HERE, "cache", "archive-rows")
    if args.fetch:
        dex_path = dex_path or fetch_archive("mangadex", cache)
        mu_path = mu_path or fetch_archive("mangaupdates", cache)

    dex_meta_path = args.dex_meta or os.path.join(HERE, "data", "mangadex", "meta.bin")
    if not os.path.isfile(dex_meta_path):
        dex_meta_path = None
    if args.fetch and not dex_meta_path:
        cached = os.path.join(cache, "mangadex-meta.bin")
        if os.path.isfile(cached) and os.path.getsize(cached) > 0:
            dex_meta_path = cached
        else:
            dex_meta_path = cached if fetch_object(DEX_META_KEY, cached) else None

    dex, dex_ambiguous = ({}, 0) if not dex_path else load_archive("mangadex", dex_path)
    mu, mu_ambiguous = ({}, 0) if not mu_path else load_archive("mangaupdates", mu_path)
    print(f"mangadex: {len(dex):,} usable ({dex_ambiguous:,} ambiguous) from {dex_path or 'missing'}")
    print(f"mangaupdates: {len(mu):,} usable ({mu_ambiguous:,} ambiguous) from {mu_path or 'missing'}")
    alt, alt_ambiguous = ({}, 0) if not dex_meta_path else load_alt_titles(dex_meta_path)
    print(f"mangadex alt titles: {len(alt):,} usable ({alt_ambiguous:,} ambiguous) "
          f"from {dex_meta_path or 'missing'}")
    if not dex and not mu and not alt:
        print("no archive rows available; refusing to write an empty meta.bin", file=sys.stderr)
        return 1

    records = []
    filled = 0
    by_source = {"mangadex": 0, "mangaupdates": 0, "mangadex-alt": 0}
    by_lib = {}
    for line in rows:
        parts = line.split("\t")
        if len(parts) < 5:
            records.append(None)
            continue
        key = title_key(parts[1])
        hit = dex.get(key) if len(key) >= MIN_KEY else None
        source = "mangadex"
        if hit is None and len(key) >= MIN_KEY:
            hit = mu.get(key)
            source = "mangaupdates"
        if hit is None and len(key) >= ALT_MIN_KEY:
            alt_hit = alt.get(key)
            if alt_hit:
                hit = (alt_hit[0], "", "")
                source = "mangadex-alt"
        if hit is None:
            records.append(None)
            continue
        synopsis, kind, year = hit
        records.append({"d": synopsis, "g": [], "s": "", "t": kind, "y": year})
        filled += 1
        by_source[source] += 1
        by_lib[parts[4]] = by_lib.get(parts[4], 0) + 1

    print(f"descriptions: {filled:,}/{len(rows):,} rows ({filled / len(rows):.1%})")
    print("  by archive:", by_source)
    print("  by shelf:", by_lib)
    if args.stats:
        return 0
    if filled < len(rows) * 0.05:
        print("coverage collapsed; refusing to overwrite the uploaded meta.bin", file=sys.stderr)
        return 1

    size = write_meta(args.out, records)
    print(f"wrote {args.out} ({size / 1e6:.1f} MB, {len(records):,} records)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
