#!/usr/bin/env python3
"""Refresh only the kunmanga series whose sitemap lastmod moved.

The sitemap index has no per-child lastmod, but the five sitemap-comic-* files
carry one <lastmod> per series.  A run therefore costs those five files (~15 MB,
100,000 series) instead of the 665 MB chapter walk, and only the series whose
stamp is newer than the one in the state file are fetched.

The chapter sitemaps are written in recency order -- the last file ends with
today's chapters -- so the newest few (sitemap-chapter-209, -210) are enough to
recover the new chapter URLs for the series that changed.  That keeps a run at
~18 MB and a few minutes.  A series the state has never seen gets only the
chapters inside that window; full history for a new title comes from
`crawl_sources.py --chapters sitemap`.

    python3 cron_kunmanga.py                    # the normal incremental run
    python3 cron_kunmanga.py --dry-run          # how many would be fetched
    python3 cron_kunmanga.py --max 500          # bounded run
    python3 cron_kunmanga.py --chapter-files 1  # narrower chapter window

The state file is written last, so an interrupted run repeats work rather than
losing a series.  A new slug is a new series, and a missing stamp is never
treated as a change -- an absent lastmod must not re-crawl the catalogue.
Series mangagg already serves are stamped without a request: build_harvest
drops their harvest rows, so fetching them would only burn the run's cap.

Measured on the live sitemaps: ~226 series/day change inside one 20,000-entry
child, so ~1,130/day across the five, and about 4 minutes at 8 req/s.
"""

import argparse
import datetime as dt
import html
import json
import os
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import crawl_sources as cs

STATE_PATH = os.path.join(cs.HERE, "cache", "cron", "kunmanga.json")
DELTA_PATH = os.path.join(cs.HERE, "cache", "cron", "kunmanga.delta.jsonl")
SERIES_LOC_RE = re.compile(r"/manga/([^/?#]+)/?$")
CHAPTER_NUMBER_RE = re.compile(r"sitemap-chapter-(\d+)\.xml")


def stamp_epoch(value):
    value = (value or "").strip()
    if not value:
        return None
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    return int(parsed.timestamp())


def load_state(path):
    try:
        with open(path, encoding="utf-8") as handle:
            data = json.load(handle)
        series = data.get("series") or {}
        return {str(k): int(v) for k, v in series.items() if str(v).lstrip("-").isdigit()}
    except (OSError, ValueError):
        return {}


def save_state(path, series):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    payload = {
        "source": "kunmanga",
        "checked": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat(),
        "series": series,
    }
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, separators=(",", ":"), sort_keys=True)
    os.replace(tmp, path)


def current_stamps(bulk_after=500):
    """slug -> newest lastmod epoch, plus the timestamps that look like a sweep.

    A regeneration writes one identical <lastmod> onto thousands of rows at
    once; on the live sitemaps 2,489 series share 2026-11-24T02:33:05, and the
    five sampled at the top of that batch are 404.  Those stamps are returned
    separately so the diff can skip them instead of re-crawling dead slugs on
    every run.  A full `crawl_sources.py` pass still sees every slug.
    """
    comics = [u for u in cs.sitemap_children("kun") if "sitemap-comic" in u]
    if len(comics) != 5:
        print("warning: %d series sitemaps, expected 5" % len(comics), file=sys.stderr)
    limiter = cs.RateLimiter(cs.RATES["kun"] + 4)
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
                epoch = stamp_epoch(stamp)
                if epoch is not None:
                    stamps[match.group(1)] = epoch
    if failures:
        raise SystemExit("%d of %d series sitemaps failed; state left untouched" % (failures, len(comics)))
    counts = {}
    for epoch in stamps.values():
        counts[epoch] = counts.get(epoch, 0) + 1
    bulk = {epoch for epoch, count in counts.items() if count > bulk_after}
    print("sitemaps: %d series stamped" % len(stamps), flush=True)
    if bulk:
        print("bulk stamps: %d values covering %d series" % (len(bulk), sum(counts[t] for t in bulk)), flush=True)
    return stamps, bulk


def recent_chapters(slugs, files, days, workers=3):
    """slug -> [chapter tokens] from the newest sitemap-chapter-* files."""
    children = [u for u in cs.sitemap_children("kun") if "sitemap-chapter" in u]
    children = [u for u in children if CHAPTER_NUMBER_RE.search(u)]
    children.sort(key=lambda u: int(CHAPTER_NUMBER_RE.search(u).group(1)))
    if not children:
        return {}
    chosen = children[-files:]
    cutoff = int((dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=days)).timestamp())
    limiter = cs.RateLimiter(cs.RATES["kun"] + 4)
    found = {}
    rows = 0
    failures = 0

    def work(url):
        limiter.wait()
        status, xml = cs.fetch(url, accept="application/xml")
        if status != 200:
            return None
        out = []
        for loc, stamp in cs.sitemap_entries(xml, with_lastmod=True):
            match = cs.CHAPTER_LOC["kun"].search(loc)
            if not match:
                continue
            slug, token = match.group(1), html.unescape(match.group(2))
            if slug not in slugs:
                continue
            epoch = stamp_epoch(stamp)
            if epoch is None or epoch < cutoff:
                continue
            out.append((slug, token))
        return out

    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(work, url) for url in chosen]
        for index, future in enumerate(as_completed(futures), 1):
            entries = future.result()
            if entries is None:
                failures += 1
                continue
            for slug, token in entries:
                found.setdefault(slug, []).append(token)
                rows += 1
            print("  chapter sitemap %d/%d, %d rows" % (index, len(chosen), rows), flush=True)

    print("chapter window: %d files, %d rows for %d series%s"
          % (len(chosen), rows, len(found), " (%d failed)" % failures if failures else ""), flush=True)
    if failures and not found:
        raise SystemExit("every chapter sitemap in the window failed; state left untouched")
    return found


def shard_of(slug):
    first = slug[:1].lower()
    return first if first.isalnum() else "_"


def import_slugs():
    """Slugs the full backfill already holds; only the rest need the index."""
    path = os.path.join(cs.HERE, "cache", "import_slugs.txt")
    try:
        with open(path, encoding="utf-8") as fh:
            return {line.strip() for line in fh if line.strip()}
    except OSError:
        slugs = set()
        with open(os.path.join(cs.HERE, "cache", "sources", "import.jsonl"), encoding="utf-8") as fh:
            for line in fh:
                try:
                    slugs.add(json.loads(line)["slug"])
                except (ValueError, KeyError):
                    continue
        with open(path + ".tmp", "w", encoding="utf-8") as out:
            out.write("\n".join(sorted(slugs)) + "\n")
        os.replace(path + ".tmp", path)
        return slugs


def mangagg_slugs():
    """Slugs the mangagg import already serves; build_harvest drops those rows."""
    path = os.path.join(os.path.dirname(cs.HERE), "mgeko-tags", "output", "mangagg.tsv")
    slugs = set()
    try:
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                slug = line.split("\t", 1)[0].strip()
                if slug:
                    slugs.add(slug)
    except OSError:
        return set()
    return slugs


def index_token_map(slugs):
    """Full chapter lists for these slugs, loading one sitemap shard at a time."""
    groups = {}
    for slug in slugs:
        groups.setdefault(shard_of(slug), []).append(slug)
    found = {}
    for shard, items in groups.items():
        path = os.path.join(cs.HERE, "cache", "kun_index", shard + ".json")
        try:
            with open(path, encoding="utf-8") as fh:
                data = json.load(fh)
        except (OSError, ValueError):
            continue
        for slug in items:
            if slug in data:
                found[slug] = data[slug]
    return found


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state", default=STATE_PATH)
    parser.add_argument("--out", default=DELTA_PATH)
    parser.add_argument("--max", type=int, default=4000, help="cap series fetched per run")
    parser.add_argument("--chapter-files", type=int, default=3, help="newest chapter sitemaps to scan")
    parser.add_argument("--days", type=int, default=10, help="ignore chapter rows older than this")
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--bulk", type=int, default=500,
                        help="a lastmod shared by more series than this is treated as a sweep")
    parser.add_argument("--include-bulk", action="store_true",
                        help="fetch sweep-touched series too (mostly 404 dead slugs)")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)

    started = time.time()
    previous = load_state(args.state)
    current, bulk = current_stamps(args.bulk)

    changed = []
    skipped = 0
    for slug, epoch in current.items():
        old = previous.get(slug)
        if old is not None and epoch <= old:
            continue
        if epoch in bulk and not args.include_bulk:
            skipped += 1
            continue
        changed.append((epoch, slug))
    changed.sort(reverse=True)
    new_series = sum(1 for _, slug in changed if slug not in previous)
    print("changed: %d (%d new), skipped %d sweep-touched, state had %d"
          % (len(changed), new_series, skipped, len(previous)), flush=True)

    # mangagg already serves these slugs and build_harvest drops their harvest
    # rows, so record the stamp and keep the fetch budget for real titles
    covered = mangagg_slugs()
    baseline = {slug: epoch for epoch, slug in changed if slug in covered}
    if baseline:
        changed = [(epoch, slug) for epoch, slug in changed if slug not in baseline]
        print("baselined: %d mangagg-covered titles (no fetch)" % len(baseline), flush=True)

    if args.dry_run:
        for epoch, slug in changed[:20]:
            print("  %s  %s" % (dt.datetime.fromtimestamp(epoch, dt.timezone.utc).date(), slug))
        print("dry run: nothing fetched, state untouched")
        return 0

    if not changed:
        save_state(args.state, {**previous, **baseline})
        print("nothing to fetch; %d stamp(s) recorded" % len(baseline), flush=True)
        return 0

    if len(changed) > args.max:
        print("capping at %d of %d; the rest stay older in state and return next run"
              % (args.max, len(changed)), flush=True)
        changed = changed[:args.max]

    wanted = {slug for _, slug in changed}
    # the backfill holds every chapter for its 37k slugs; only titles it has
    # never seen need the index, so this stays a handful on a normal run
    known = import_slugs()
    index_map = index_token_map(
        [slug for slug in wanted if slug not in previous and slug not in known]
    )
    if index_map:
        print("index: %d new title(s) get their full chapter list" % len(index_map), flush=True)
    chapters = recent_chapters(wanted, max(1, args.chapter_files), args.days)

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    limiter = cs.RateLimiter(cs.RATES["kun"])
    merged = dict(previous)
    merged.update(baseline)
    saved = 0
    missed = 0
    with ThreadPoolExecutor(max_workers=args.workers) as pool, open(args.out, "a", encoding="utf-8") as out:
        def work(slug):
            limiter.wait()
            status, page = cs.fetch(cs.KUN + "/manga/" + slug + "/")
            if status != 200 or not page:
                return None
            return cs.parse_kun_series(slug, page)

        futures = {pool.submit(work, slug): slug for _, slug in changed}
        for index, future in enumerate(as_completed(futures), 1):
            slug = futures[future]
            try:
                item = future.result()
            except Exception:
                item = None
            if not item:
                missed += 1
                continue
            tokens = [c["n"] for c in item.get("chapters") or []]
            tokens.extend(chapters.get(slug) or [])
            # the series page renders only the newest two chapters; a title the
            # backfill has never seen takes its full list from the sitemap index
            if slug in index_map:
                tokens.extend(index_map[slug])
            merged_item = cs.record("kun", slug, item.get("title"), item.get("desc"),
                                    item.get("cover"), tokens, item.get("url"))
            out.write(json.dumps(merged_item, ensure_ascii=False) + "\n")
            out.flush()
            saved += 1
            merged[slug] = current[slug]
            if index % 200 == 0:
                rate = index / max(0.001, time.time() - started)
                print("  %d/%d saved=%d miss=%d %.1f req/s" % (index, len(changed), saved, missed, rate), flush=True)

    save_state(args.state, merged)
    elapsed = time.time() - started
    print("done: %d refreshed, %d missed, %.1fs, %.1f req/s" % (saved, missed, elapsed, saved / max(0.001, elapsed)))
    if missed:
        print("missed series keep their old stamp and are retried next run")
    return 0 if missed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
