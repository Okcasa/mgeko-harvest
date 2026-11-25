#!/usr/bin/env python3
"""Backfill kunmanga's update dates from its series sitemaps.

kunmanga publishes one <lastmod> per series in sitemap-comic-1..5.xml, and that
stamp is the series' newest chapter date -- it is what cron_kunmanga.py diffs to
decide a series changed.  The cron reads all five files every run, but its state
file only records the slugs it actually fetched, so a title the backfill
imported once and never touched since ships updated=0 and can never reach the
Updated feed even though its date is published.  This walks the same five files
and writes every stamp where build_harvest.py looks for them:

    cache/cron/kun_stamps.json
    {"source": "kunmanga", "checked": "...", "bulk": [...], "stamps": {slug: epoch}}

A sitemap regeneration writes one identical stamp onto thousands of rows at
once (2,489 series shared 2026-11-24T02:33:05 on the live files, and the top of
that batch is 404 slugs).  A value shared by more than --bulk series is that
sweep, not releases, and is left out: the row keeps 0 and stays out of the feed
rather than claiming it moved on the day the sitemap was rebuilt.

    python3 kun_stamps.py                 # write the state file
    python3 kun_stamps.py --dry-run       # report only
    python3 kun_stamps.py --out /tmp/kun_stamps.json
"""

import argparse
import datetime as dt
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
WS = os.path.join(HERE, "ws")
OUT = os.path.join(WS, "mgeko-tags-ui", "cache", "cron", "kun_stamps.json")

sys.path.insert(0, HERE)
import cron_kunmanga as ck  # noqa: E402


def save(path, stamps, bulk):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
    payload = {
        "source": "kunmanga",
        "checked": now.isoformat(),
        "bulk": sorted(bulk),
        "stamps": stamps,
    }
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, separators=(",", ":"), sort_keys=True)
    os.replace(tmp, path)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", default=OUT, help="state file to write")
    parser.add_argument("--bulk", type=int, default=500,
                        help="a lastmod shared by more series than this is treated as a sweep")
    parser.add_argument("--dry-run", action="store_true", help="report without writing")
    args = parser.parse_args(argv)

    started = time.time()
    stamps, bulk = ck.current_stamps(bulk_after=args.bulk)
    kept = {slug: epoch for slug, epoch in stamps.items() if epoch not in bulk}
    recent = sum(1 for epoch in kept.values() if epoch >= int(time.time()) - 7 * 86400)
    newest = max(kept.values()) if kept else 0
    print("kun stamps: %d series, %d usable, %d within 7 days, newest %s (%.1fs)"
          % (len(stamps), len(kept), recent,
             dt.datetime.fromtimestamp(newest, dt.timezone.utc).strftime("%Y-%m-%d")
             if newest else "-",
             time.time() - started), flush=True)
    if args.dry_run:
        print("dry run: %s not written" % args.out)
        return 0
    save(args.out, kept, bulk)
    print("wrote %s" % args.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
