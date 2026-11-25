#!/usr/bin/env python3
"""Turn the harvested records into library-shelf rows.

Sources, in priority order: the full kunmanga/bato1 import, the incremental
kunmanga delta the cron writes, then Comick's recent-update file.  A slug only
appears once; when a later file has the same source it refreshes the metadata
and unions the chapter list, and a slug from a different source is skipped
rather than mixing two token namespaces.

kunmanga covers need the Worker's referer, so they keep the /img/kun/ path;
bato1 and Comick covers hotlink and stay absolute.

Run:  python3 cloud/build_harvest.py
"""

import json
import os
import sys
import time
from urllib.parse import quote, urlsplit

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UI = os.path.join(os.path.dirname(HERE), "mgeko-tags-ui")
OUT = os.path.join(HERE, "output", "harvest.tsv")
MANGAGG = os.path.join(HERE, "output", "mangagg.tsv")

FILES = [
    os.path.join(UI, "cache", "sources", "import.jsonl"),
    os.path.join(UI, "cache", "cron", "kunmanga.delta.jsonl"),
    os.path.join(UI, "cache", "sources", "comick.jsonl"),
]
SOURCES = {"kunmanga": "kun", "bato1": "bato", "comick": "comick"}

# the two cron state files, both pulled before this runs.  They hold the only
# honest update dates the harvest has: kunmanga's sitemap lastmod per series and
# Comick's newest chapter stamp per comic.
STATE_KUN = os.path.join(UI, "cache", "cron", "kunmanga.json")
STATE_COMICK = os.path.join(UI, "cache", "cron", "comick.json")
PRIORITY = {"kun": 0, "bato": 1, "comick": 2}

sys.path.insert(0, UI)
try:
    from crawl_sources import clean_title
except Exception:  # pragma: no cover
    def clean_title(title, slug=""):
        return " ".join(str(title or "").split())


def clean(text):
    return " ".join(str(text or "").split())


def proxied(source, raw_url):
    try:
        parts = urlsplit(str(raw_url or "").strip())
    except ValueError:
        return ""
    if parts.scheme not in ("http", "https") or not parts.netloc:
        return ""
    path = quote(parts.path, safe="/%:@&=+~")
    return f"/img/{source}/{parts.netloc}{path}"


def load_mangagg():
    slugs = set()
    if os.path.exists(MANGAGG):
        with open(MANGAGG, encoding="utf-8") as fh:
            for line in fh:
                slug = line.split("\t", 1)[0].strip()
                if slug:
                    slugs.add(slug)
    return slugs


def load_update_stamps():
    """source -> {slug: the epoch its newest chapter arrived}.

    Every file this script reads was rewritten by the crawler minutes ago, so a
    time.time() stamp (or a file mtime) says nothing about the series and would
    mark the whole file updated.  That is exactly how the feed came to hold
    23,733 titles sharing three bake timestamps: 98% of it was bake time, not
    release dates.  A row whose chapter date is unknown keeps 0 and stays out of
    the updated feed instead of claiming it moved today.
    """
    kun, comick = {}, {}
    try:
        with open(STATE_KUN, encoding="utf-8") as fh:
            for slug, epoch in (json.load(fh).get("series") or {}).items():
                try:
                    kun[str(slug)] = int(epoch)
                except (TypeError, ValueError):
                    continue
    except (OSError, ValueError):
        pass
    try:
        with open(STATE_COMICK, encoding="utf-8") as fh:
            for slug, epoch in (json.load(fh).get("stamps") or {}).items():
                try:
                    comick[str(slug)] = int(epoch)
                except (TypeError, ValueError):
                    continue
    except (OSError, ValueError):
        pass
    return {"kun": kun, "comick": comick}


def main():
    taken = load_mangagg()
    stamps = load_update_stamps()
    picked = {}
    order = []
    dropped = 0

    for path in FILES:
        if not os.path.exists(path):
            continue
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except ValueError:
                    continue
                source = SOURCES.get(clean(rec.get("source")))
                slug = clean(rec.get("slug"))
                title = clean(clean_title(rec.get("title"), slug))
                if not source or not slug or not title:
                    continue
                if slug in taken:
                    dropped += 1
                    continue
                cover = clean(rec.get("cover"))
                if source == "kun":
                    cover = proxied("kun", cover)
                tokens = [clean(ch.get("n")) for ch in rec.get("chapters") or [] if clean(ch.get("n"))]
                url = clean(rec.get("url"))

                # the series' own chapter date, never the run's clock: the
                # sitemap lastmod for kunmanga, the newest chapter stamp Comick
                # put on the record, and the record's own field for anything
                # that has one.  Unknown stays 0 and the row simply does not
                # appear as freshly updated.
                stamp = stamps.get(source, {}).get(slug) or int(rec.get("updated") or 0)

                current = picked.get(slug)
                if current is None:
                    picked[slug] = {
                        "title": title,
                        "cover": cover,
                        "url": url,
                        "source": source,
                        "chapters": set(tokens),
                        "updated": stamp,
                    }
                    order.append(slug)
                elif current["source"] == source:
                    current["title"] = title or current["title"]
                    current["cover"] = cover or current["cover"]
                    current["url"] = url or current["url"]
                    current["chapters"].update(tokens)
                    current["updated"] = max(current.get("updated", 0), stamp)
                # another source with the same slug: keep the higher-priority one

    rows = [(slug, picked[slug]) for slug in order]
    rows.sort(key=lambda pair: (pair[1]["title"].lower(), pair[0]))

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    counts = {}
    with open(OUT, "w", encoding="utf-8") as fh:
        for slug, item in rows:
            counts[item["source"]] = counts.get(item["source"], 0) + 1
            fh.write(f"{slug}\t{item['title']}\t{item['cover']}\t{item['url']}\t{item['source']}"
                     f"\t{len(item['chapters'])}\t{item.get('updated', 0)}\n")

    with_cover = sum(1 for _, item in rows if item["cover"])
    print(f"harvest  {len(rows):,} rows  {with_cover:,} with covers  "
          f"{dropped:,} already in mangagg  {counts}  -> {OUT}")


if __name__ == "__main__":
    main()
