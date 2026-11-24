#!/usr/bin/env python3
"""Carry the harvest's working files between runs through the R2 bucket.

The crawl is incremental: it needs the lastmod state it wrote, the delta rows,
Comick's recent feed and the large static inputs the packers read.  GitHub's
runners start empty, so those travel as objects under state/ in the same bucket
the site is served from.

Small, changing files go up after every run.  The static inputs are one gzipped
tarball; the workflow keeps that tarball in the Actions cache, so it is only
downloaded when the cache is cold or the inputs are refreshed.

    python3 state_sync.py pull                       # bucket -> ws/
    python3 state_sync.py push                       # ws/ -> bucket
    python3 state_sync.py inputs --upload            # one-off: pack the real tree
    python3 state_sync.py inputs --download          # restore ws/ inputs
    python3 state_sync.py status                     # what is where
"""

import argparse
import gzip
import os
import shutil
import subprocess
import sys
import tarfile

ROOT = os.path.dirname(os.path.abspath(__file__))
WS = os.path.join(ROOT, "ws")
BUCKET = os.environ.get("R2_BUCKET", "mgeko-tags-data")
INPUTS_KEY = "state/inputs.tar.gz"

WRANGLER = ["wrangler"] if shutil.which("wrangler") else ["npx", "wrangler@4"]

# (object key, path inside ws, stored gzipped)
MOVING = [
    ("state/kunmanga.json", "mgeko-tags-ui/cache/cron/kunmanga.json", False),
    ("state/kunmanga.delta.jsonl.gz", "mgeko-tags-ui/cache/cron/kunmanga.delta.jsonl", True),
    ("state/comick.json", "mgeko-tags-ui/cache/cron/comick.json", False),
    ("state/comick.jsonl.gz", "mgeko-tags-ui/cache/sources/comick.jsonl", True),
    ("state/import_slugs.txt.gz", "mgeko-tags-ui/cache/import_slugs.txt", True),
    ("state/upload-state.json", "mgeko-tags/cloud/.upload-state.json", False),
]

# the packers read these; a harvest run never changes them
STATIC = [
    "mgeko-tags-ui/cache/sources/import.jsonl",
    "mgeko-tags-ui/cache/kun_index",
    # the collision filter: harvest rows for slugs mangagg already serves are
    # dropped, so the runner needs the same list the local build uses
    "mgeko-tags/output/mangagg.tsv",
    "mgeko-tags/output/catalog_full.jsonl",
    "mgeko-tags/cache/catalog/info.jsonl",
    "mgeko-tags/cache/catalog/first_seen.json",
    "mgeko-tags/cache/mangagg_meta.jsonl",
]


def size_of(path):
    if os.path.isdir(path):
        total = 0
        for root, _dirs, files in os.walk(path):
            for name in files:
                total += os.path.getsize(os.path.join(root, name))
        return total
    return os.path.getsize(path)


def human(size):
    return "%.1f MB" % (size / 1e6) if size >= 1e6 else "%d KB" % max(1, size // 1000)


def path_of(rel, base=None):
    return os.path.join(base or WS, rel)


def wrangler(args):
    done = subprocess.run(WRANGLER + args, capture_output=True, text=True)
    detail = (done.stderr or done.stdout or "").strip().splitlines()
    return done.returncode == 0, (detail[-1] if detail else "")


def get(key, dest):
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    if os.path.exists(dest):
        os.remove(dest)
    ok, detail = wrangler(["r2", "object", "get", BUCKET + "/" + key, "--file", dest, "--remote"])
    if not ok and os.path.exists(dest):
        os.remove(dest)
    return ok, detail


def put(key, src):
    return wrangler(["r2", "object", "put", BUCKET + "/" + key, "--file", src, "--remote"])


def gzip_copy(src, dst):
    with open(src, "rb") as fh, gzip.open(dst, "wb", compresslevel=6) as out:
        shutil.copyfileobj(fh, out, 1 << 20)


def gunzip_copy(src, dst):
    with gzip.open(src, "rb") as fh, open(dst, "wb") as out:
        shutil.copyfileobj(fh, out, 1 << 20)


def pull():
    missing = []
    for key, rel, gz in MOVING:
        dest = path_of(rel)
        if gz:
            tmp = dest + ".part"
            ok, detail = get(key, tmp)
            if not ok:
                missing.append(key)
                continue
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            gunzip_copy(tmp, dest)
            os.remove(tmp)
        elif not get(key, dest)[0]:
            missing.append(key)
            continue
        print("  pulled %-32s %s" % (key, human(os.path.getsize(dest))))
    if missing:
        print("  not in the bucket yet: " + ", ".join(missing))
    return 0


def push():
    failed = []
    for key, rel, gz in MOVING:
        src = path_of(rel)
        if not os.path.exists(src):
            continue
        if gz:
            tmp = src + ".part"
            gzip_copy(src, tmp)
            ok, detail = put(key, tmp)
            os.remove(tmp)
        else:
            ok, detail = put(key, src)
        if ok:
            print("  pushed %-32s %s" % (key, human(os.path.getsize(src))))
        else:
            failed.append(key)
            print("  ! %s: %s" % (key, detail or "wrangler failed"))
    if failed:
        print("%d object(s) failed to upload" % len(failed))
        return 1
    return 0


def inputs_present(base=None):
    return all(os.path.exists(path_of(rel, base)) for rel in STATIC)


def make_inputs(dest, base):
    with tarfile.open(dest, "w:gz") as tar:
        for rel in STATIC:
            full = path_of(rel, base)
            if os.path.exists(full):
                tar.add(full, arcname=rel)
            else:
                print("  warning: %s is missing from %s" % (rel, base))
    return os.path.getsize(dest)


def extract_inputs(src):
    with tarfile.open(src, "r:gz") as tar:
        try:
            tar.extractall(WS, filter="data")
        except TypeError:  # python < 3.12
            tar.extractall(WS)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("action", choices=["pull", "push", "inputs", "status"])
    parser.add_argument("--upload", action="store_true", help="inputs: pack and upload")
    parser.add_argument("--download", action="store_true", help="inputs: fetch and extract")
    parser.add_argument("--if-missing", action="store_true", help="inputs: only when ws/ lacks them")
    parser.add_argument("--source", default=WS,
                        help="inputs --upload: tree holding mgeko-tags and mgeko-tags-ui")
    args = parser.parse_args(argv)

    if args.action == "pull":
        return pull()

    if args.action == "push":
        return push()

    if args.action == "status":
        for rel in STATIC:
            full = path_of(rel)
            print("  %-52s %s" % (rel, human(size_of(full)) if os.path.exists(full) else "missing"))
        for key, rel, _gz in MOVING:
            full = path_of(rel)
            print("  %-52s %s" % (rel, human(size_of(full)) if os.path.exists(full) else "missing"))
        return 0

    # inputs
    if args.upload:
        tmp = os.path.join(ROOT, "inputs.tar.gz")
        size = make_inputs(tmp, args.source)
        print("packed %s from %s" % (human(size), args.source))
        ok, detail = put(INPUTS_KEY, tmp)
        os.remove(tmp)
        print(("uploaded " if ok else "! failed ") + INPUTS_KEY + ("" if ok else ": " + detail))
        return 0 if ok else 1

    if args.if_missing and inputs_present():
        print("inputs already in ws/, nothing to download")
        return 0
    tmp = os.path.join(ROOT, "inputs.tar.gz")
    ok, detail = get(INPUTS_KEY, tmp)
    if not ok:
        print("! could not fetch %s: %s" % (INPUTS_KEY, detail))
        return 1
    extract_inputs(tmp)
    size = os.path.getsize(tmp)
    os.remove(tmp)
    print("restored %s (%s) into ws/" % (INPUTS_KEY, human(size)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
