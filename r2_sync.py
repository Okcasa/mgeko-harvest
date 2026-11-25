#!/usr/bin/env python3
"""Upload only the R2 objects whose bytes changed since the last successful run.

The packing step rewrites whole files even when eighteen rows arrived, so
re-uploading the bucket every night would push ~120 MB for nothing.  A sha256 is
kept per object in `.upload-state.json`; an object goes up when its hash differs
from the last upload, and the new hash is recorded only after wrangler exits 0,
so a failed upload is retried next run instead of being quietly skipped.

    python3 r2_sync.py              # upload what changed
    python3 r2_sync.py --dry-run    # say what would go, change nothing
    python3 r2_sync.py --all        # ignore the manifest, re-upload everything

The key layout is the one the Worker reads (see README.md): every shelf's packed
files, each shelf's `rows.bin` as its TSV uploaded verbatim, the mgeko feed, and
the sitemaps.
"""

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DATA = os.path.join(HERE, "data")
OUT = os.path.join(ROOT, "output")
STATE = os.path.join(HERE, ".upload-state.json")
BUCKET = "mgeko-tags-data"

# the three shelves whose packed files live under data/<shelf>/, and the TSV each
# one is uploaded verbatim as
SHELVES = {
    # library's rows.bin is packed by build_data.py (mangagg + harvest), so it
    # is uploaded from data/library and has no TSV of its own here
    "library": None,
    "mangadex": "mangadex.tsv",
    "mangaupdates": "mangaupdates.tsv",
}


def objects():
    """(key, path) for everything the Worker can read."""
    out = []
    for shelf, tsv in SHELVES.items():
        folder = os.path.join(DATA, shelf)
        if not os.path.isdir(folder):
            continue
        for name in sorted(os.listdir(folder)):
            if name.endswith(".tmp"):
                continue
            out.append((shelf + "/" + name, os.path.join(folder, name)))
        if tsv:
            out.append((shelf + "/rows.bin", os.path.join(OUT, tsv)))
    # the mgeko catalogue: rows.json plus the shards and indexes build_data.py
    # writes beside it.  The Worker reads the shards, so they must travel with
    # every upload -- version.json goes up last and switches them over together.
    catalog = os.path.join(DATA, "catalog")
    if os.path.isdir(catalog):
        for name in sorted(os.listdir(catalog)):
            if name.endswith(".tmp"):
                continue
            out.append(("catalog/" + name, os.path.join(catalog, name)))
    sitemaps = os.path.join(DATA, "sitemap")
    if os.path.isdir(sitemaps):
        for name in sorted(os.listdir(sitemaps)):
            if name.endswith(".xml"):
                out.append(("sitemap/" + name, os.path.join(sitemaps, name)))
    # harvested chapter shards: one small JSON per source and first letter,
    # read on demand by the harvest reader
    harvest = os.path.join(DATA, "harvest")
    if os.path.isdir(harvest):
        for root, _dirs, files in os.walk(harvest):
            for name in sorted(files):
                if name.endswith(".tmp"):
                    continue
                path = os.path.join(root, name)
                out.append((os.path.relpath(path, DATA).replace(os.sep, "/"), path))
    # chapter-1 image lists, one file per first letter (see reader_scraper.py).
    # They are uploaded with everything else but deliberately left out of the
    # data version: a new reader file must not throw away the shelf caches.
    reader = os.path.join(DATA, "reader")
    if os.path.isdir(reader):
        for name in sorted(os.listdir(reader)):
            if name.endswith(".json"):
                out.append(("reader/" + name, os.path.join(reader, name)))
    return [(key, path) for key, path in out if os.path.exists(path)]


def digest(path):
    sha = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            sha.update(chunk)
    return sha.hexdigest()


def load_state():
    if not os.path.exists(STATE):
        return {}
    try:
        with open(STATE, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return {}


def save_state(state):
    tmp = STATE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(state, fh, indent=1, sort_keys=True)
    os.replace(tmp, STATE)


# the runner installs wrangler globally, which is far quicker than npx resolving
# it on every one of the ~90 objects a run uploads
WRANGLER = ["wrangler"] if shutil.which("wrangler") else ["npx", "wrangler@4"]


def put(key, path):
    cmd = WRANGLER + ["r2", "object", "put", f"{BUCKET}/{key}",
                      "--file", path, "--remote"]
    done = subprocess.run(cmd, cwd=HERE, capture_output=True, text=True)
    if done.returncode != 0:
        detail = (done.stderr or done.stdout or "").strip().splitlines()
        print(f"  ! {key}: {detail[-1] if detail else 'wrangler failed'}", flush=True)
    return done.returncode == 0


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dry-run", action="store_true", help="list, do not upload")
    parser.add_argument("--all", action="store_true", help="ignore the manifest")
    args = parser.parse_args()

    state = {} if args.all else load_state()
    pending, skipped, missing = [], 0, []
    for key, path in objects():
        if key.endswith("/rows.bin") and not os.path.exists(path):
            missing.append(key)
            continue
        sha = digest(path)
        if state.get(key) == sha:
            skipped += 1
            continue
        pending.append((key, path, sha))

    total = sum(os.path.getsize(path) for _, path, _ in pending)
    print(f"{len(pending)} object(s) to upload ({total / 1e6:.1f} MB), "
          f"{skipped} unchanged", flush=True)
    for key in missing:
        print(f"  ! no source file for {key}", flush=True)
    if args.dry_run:
        for key, path, _ in pending:
            print(f"  would put {key} ({os.path.getsize(path) / 1e6:.1f} MB)", flush=True)
        return 0

    failed = 0
    for key, path, sha in pending:
        size = os.path.getsize(path) / 1e6
        print(f"  put {key} ({size:.1f} MB)", flush=True)
        if put(key, path):
            state[key] = sha
            save_state(state)
        else:
            failed += 1

    print(f"done: {len(pending) - failed} uploaded, {failed} failed, {skipped} unchanged", flush=True)
    if failed:
        return 1

    # The Worker keys its colo cache by this stamp, so every object of a refresh
    # switches over together and a reader can never mix two uploads.  It goes up
    # last, and only when every object above made it.
    shelf_state = {key: sha for key, sha in state.items() if not key.startswith("reader/")}
    version = hashlib.sha256(json.dumps(shelf_state, sort_keys=True).encode()).hexdigest()[:16]
    version_path = os.path.join(HERE, ".version.json")
    with open(version_path, "w", encoding="utf-8") as fh:
        json.dump({"version": version, "objects": len(state)}, fh)
    print(f"  put version.json ({version})", flush=True)
    return 0 if put("version.json", version_path) else 1


if __name__ == "__main__":
    sys.exit(main())
