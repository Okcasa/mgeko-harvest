#!/usr/bin/env python3
"""Collapse the kunmanga delta to one record per slug.

cron_kunmanga.py appends a record for every series it touches, so the file
grows by a whole pass each run while build_harvest.py and
build_harvest_chapters.py union the same chapter tokens over and over.  Both
readers merge by slug, so a single record holding the union of the tokens and
the newest metadata produces identical rows in a fraction of the space.

Chapter entries are {"n": token, "u": url} and the url is derived from the slug
and token, so deduping by token loses nothing.

Run:  python3 compact_delta.py [delta path]
"""

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT = os.path.join(HERE, "ws", "mgeko-tags-ui", "cache", "cron", "kunmanga.delta.jsonl")


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT
    if not os.path.exists(path):
        print("delta: none")
        return 0

    before = os.path.getsize(path)
    picked = {}
    order = []
    lines = 0

    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except ValueError:
                continue
            slug = str(rec.get("slug") or "").strip()
            if not slug:
                continue
            lines += 1
            current = picked.get(slug)
            if current is None:
                current = {"rec": {}, "chapters": {}}
                picked[slug] = current
                order.append(slug)
            # newest metadata wins; the union of the tokens is kept below
            current["rec"].update(rec)
            for chapter in rec.get("chapters") or []:
                token = str(chapter.get("n") or "").strip()
                if token:
                    current["chapters"][token] = chapter

    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as out:
        for slug in order:
            current = picked[slug]
            rec = dict(current["rec"])
            rec["chapters"] = list(current["chapters"].values())
            out.write(json.dumps(rec, ensure_ascii=False) + "\n")

    after = os.path.getsize(tmp)
    os.replace(tmp, path)

    print("delta: %d line(s) -> %d slug(s), %.1f MB -> %.1f MB"
          % (lines, len(order), before / 1e6, after / 1e6))
    return 0


if __name__ == "__main__":
    sys.exit(main())
