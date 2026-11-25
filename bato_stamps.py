#!/usr/bin/env python3
"""Backfill bato1's update dates from its series sitemaps.

bato1 publishes one <lastmod> per series in sitemap-comic*-1.xml, and that
stamp is the series' newest chapter stamp (checked against the chapter
sitemaps).  crawl_sources.py reads it while assembling a record, but the shelf
that already exists was built without it, so every bato row ships updated=0
and can never reach the Updated feed.  This walks the series sitemaps and
writes the dates where build_harvest.py looks for them:

    cache/cron/bato.json
    {"source": "bato1", "checked": "...", "stamps": {slug: epoch}}

A sitemap regeneration writes one identical stamp onto thousands of rows at
once.  A value shared by more than --bulk series is that sweep, not releases,
and is left out: the row keeps 0 and stays out of the feed rather than
claiming it moved on the day the sitemap was rebuilt.  (On the live files the
sweeps are 2,901 series on one second and a few dozen on another; every real
stamp is shared by at most a handful of series.)

    python3 bato_stamps.py                 # write the state file
    python3 bato_stamps.py --dry-run       # report only
    python3 bato_stamps.py --out /tmp/bato.json
"""

import argparse
import datetime as dt
import json
import os
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

HERE = os.path.dirname(os.path.abspath(__file__))
WS = os.path.join(HERE, "ws")
OUT = os.path.join(WS, "mgeko-tags-ui", "cache", "cron", "bato.json")

sys.path.insert(0, HERE)
import crawl_sources as cs  # noqa: E402

SERIES_LOC_RE = re.compile(r"/manga/([^/?#]+)/?$")


def series_stamps(bulk_after=500):
    """slug -> newest lastmod epoch, plus the stamps that look like a sweep."""
    comics = [u for u in cs.sitemap_children("bato") if "sitemap-comic" in u]
    if not comics:
        raise SystemExit("bato: no series sitemaps in the index")
    limiter = cs.RateLimiter(cs.RATES["bato"] + 4)
    stamps = {}
    failures = 0

    def work(url):
        limiter.wait()
        status, xml = cs.fetch(url, accept="application/xml")
        if status != 200:
            return None
        return cs.sitemap_entries(xml, with_lastmod=True)

    with ThreadPoolExecutor(max_workers=5) as pool:
        futures = [pool.submit(work, url) for url in comics]
        for future in as_completed(futures):
            entries = future.result()
            if entries is None:
                failures += 1
                continue
            for loc, stamp in entries:
                match = SERIES_LOC_RE.search(loc)
                if not match:
                    continue
                epoch = cs.stamp_epoch(stamp)
                if epoch is not None:
                    stamps[match.group(1)] = epoch
    if failures:
        raise SystemExit("%d of %d series sitemaps failed; state left untouched"
                         % (failures, len(comics)))

    counts = {}
    for epoch in stamps.values():
        counts[epoch] = counts.get(epoch, 0) + 1
    bulk = {epoch for epoch, count in counts.items() if count > bulk_after}
    dropped = sum(counts[epoch] for epoch in bulk)
    if bulk:
        print("bulk stamps: %d values covering %d series" % (len(bulk), dropped), flush=True)
    return stamps, bulk


def save(path, stamps, bulk):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
    payload = {
        "source": "bato1",
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
    stamps, bulk = series_stamps(bulk_after=args.bulk)
    kept = {slug: epoch for slug, epoch in stamps.items() if epoch not in bulk}
    recent = sum(1 for epoch in kept.values() if epoch >= int(time.time()) - 7 * 86400)
    newest = max(kept.values()) if kept else 0
    print("bato stamps: %d series, %d usable, %d within 7 days, newest %s (%.1fs)"
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
