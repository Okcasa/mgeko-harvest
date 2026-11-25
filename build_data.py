#!/usr/bin/env python3
"""Pack the four shelves into the files the Cloudflare Worker reads from R2.

serve.py keeps a shelf as three integer arrays plus one title blob and reads
rows back out of the TSV with pread.  A Worker has no filesystem, so the same
split is written out as files:

    <shelf>/index.bin   header + row offsets + lowercased-title offsets
    <shelf>/lower.txt   every lowercased title, one per line
    <shelf>/ids.bin     every ident, sorted, one per line   (cover lookups)
    <shelf>/ids.idx     ident offsets + the row each ident belongs to

The TSV itself is uploaded verbatim as <shelf>/rows.bin, so a page is a byte
range read and the row parsing on the Worker is the same tab split as here.

The offsets in index.bin are UTF-16 code units, not bytes: the Worker holds the
title blob as a JS string, where indexOf and slice count UTF-16 units.  Python
counts code points, so each title's length is measured through utf-16-le to
keep the two views of the same text in step (astral characters are 2 units).

Run:  python3 cloud/build_data.py
"""

import argparse
import array
import datetime
import json
import os
import re
import shutil
import struct
import sys
import time
from urllib.parse import quote

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(HERE, "cloud", "data")

# the title pages carry absolute URLs in their canonical link, their og:image and
# the sitemap, so the origin has to be baked in.  A custom domain means changing
# this and re-running:  SITE_ORIGIN=https://example.com python3 cloud/build_data.py
SITE_ORIGIN = os.environ.get("SITE_ORIGIN", "https://mgeko-tags.okcasa27.workers.dev").rstrip("/")

# how much of the synopsis a title page keeps, and how many of its tags
DESC_CAP = 1400
TAG_CAP = 8
SITEMAP_CHUNK = 5000

# name, source TSV, minimum tab fields, index of the year, index of the rating
SHELVES = [
    # mangagg is no longer shipped: the library shelf is the harvest alone
    ("library", os.path.join(HERE, "output", "harvest.tsv"), 3, None, None),
    ("mangadex", os.path.join(HERE, "output", "mangadex.tsv"), 6, 4, None),
    ("mangaupdates", os.path.join(HERE, "output", "mangaupdates.tsv"), 8, 5, 6),
]

# a second TSV that feeds an existing shelf.  The harvest rows are already in
# the library shelf's shape (slug, title, cover, source page), so they are
# concatenated after its own rows and the result is written as rows.bin.
EXTRA_ROWS = {}

# shelves whose rows.bin is uploaded verbatim even without a second TSV
VERBATIM_ROWS = {"library"}

CATALOG_FULL = os.path.join(HERE, "output", "catalog_full.jsonl")
CATALOG_PATH = CATALOG_FULL if os.path.exists(CATALOG_FULL) else os.path.join(HERE, "output", "catalog.jsonl")
INFO_PATH = os.path.join(HERE, "cache", "catalog", "info.jsonl")
FIRST_SEEN_PATH = os.path.join(HERE, "cache", "catalog", "first_seen.json")
MGEKO_BASE = "https://www.mgeko.cc/manga/"

MAGIC = b"MKIX"
VERSION = 1

# The full crawl sits beside each shelf's compact TSV, and it is the only place
# with a synopsis long enough to read and a tag list to group titles by.  Joined
# by the same id the TSV row starts with.
META_SOURCES = {
    "library": {
        "path": os.path.join(HERE, "cache", "mangagg_meta.jsonl"),
        "key": "slug",
    },
    "mangadex": {
        "path": os.path.join(HERE, "..", "mangadex", "output", "mangadex_catalog.jsonl"),
        "key": "id",
    },
    "mangaupdates": {
        "path": os.path.join(HERE, "..", "mangaupdates", "output", "mangaupdates_catalog.jsonl"),
        "key": "series_id",
    },
}

GENRE_MAGIC = b"MKGN"
META_MAGIC = b"MKMT"


def utf16_len(text):
    return len(text.encode("utf-16-le")) // 2


def clean(text):
    return re.sub(r"\s+", " ", str(text or "")).strip()


def shorten(text, cap):
    """Cut at a word boundary and mark the cut, so a synopsis never ends mid-word."""
    text = clean(text)
    if len(text) <= cap:
        return text
    cut = text[:cap]
    space = cut.rfind(" ")
    return (cut[:space] if space > cap * 0.6 else cut).rstrip(",;: ") + "\u2026"


def iso_day(timestamp):
    try:
        return datetime.datetime.fromtimestamp(int(timestamp), datetime.timezone.utc).strftime("%Y-%m-%d")
    except (TypeError, ValueError, OSError):
        return ""


def meta_record(name, raw):
    """One title page's extra fields, keyed short: they are stored once per row."""
    if name == "library":
        genres = [clean(genre) for genre in (raw.get("g") or []) if clean(genre)]
        return {
            "g": genres[:TAG_CAP],
            "d": shorten(raw.get("d"), DESC_CAP),
            "s": clean(raw.get("s")),
            "t": clean(raw.get("t")),
            "y": clean(raw.get("y"))[:10],
            "a": [shorten(title, 90) for title in (raw.get("a") or []) if clean(title)][:2],
        }
    if name == "mangadex":
        tags = [clean(tag) for tag in (raw.get("tags") or []) if clean(tag)]
        alt = [clean(title) for title in (raw.get("alt_titles") or []) if clean(title)][:2]
        return {
            "g": tags[:TAG_CAP],
            "d": shorten(raw.get("description"), DESC_CAP),
            "u": clean(raw.get("updated_at"))[:10],
            # when the catalogue first listed this title.  mangadex is the only
            # source that publishes it, so it is the only shelf whose pages can
            # say a title is new rather than guessing from a release year.
            "c": clean(raw.get("created_at"))[:10],
            "s": clean(raw.get("status")),
            "a": [shorten(title, 90) for title in alt],
        }
    genres = [clean(genre.get("genre") if isinstance(genre, dict) else genre)
              for genre in (raw.get("genres") or [])]
    updated = raw.get("last_updated") or {}
    stamp = updated.get("timestamp") if isinstance(updated, dict) else None
    return {
        "g": [genre for genre in genres if genre][:TAG_CAP],
        "d": shorten(raw.get("description"), DESC_CAP),
        "u": iso_day(stamp),
        "s": "",
        "t": clean(raw.get("type")),
        "v": int(raw.get("rating_votes") or 0),
    }


def write_meta(folder, records, count):
    """Row-ordered JSON beside the rows: offsets are absolute file offsets, so a
    title page is one ranged GET for its own record and no index read."""
    at = array.array("I")
    payload = bytearray()
    for record in records:
        at.append(len(payload))
        if record is not None:
            payload += json.dumps(record, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    at.append(len(payload))
    header = META_MAGIC + struct.pack("<III", 1, count, len(payload))
    path = os.path.join(folder, "meta.bin")
    with open(path, "wb") as fh:
        fh.write(header)
        fh.write(at.tobytes())
        fh.write(bytes(payload))
    filled = sum(1 for record in records if record is not None)
    return {"bytes": os.path.getsize(path), "filled": filled, "payload_start": len(header) + (count + 1) * 4}


def write_genres(folder, row_genres):
    """genre -> the rows carrying it, so a title page can offer real neighbours."""
    table = {}
    for row, genres in enumerate(row_genres):
        for genre in genres or ():
            table.setdefault(genre, []).append(row)
    names = sorted(table, key=lambda name: (name.lower(), name))
    names_blob = bytearray()
    name_at, name_len, row_at, row_cnt = [], [], [], []
    for name in names:
        encoded = name.encode("utf-8")
        name_at.append(len(names_blob))
        name_len.append(len(encoded))
        names_blob += encoded
        row_at.append(sum(row_cnt))
        row_cnt.append(len(table[name]))
    while len(names_blob) % 4:
        names_blob += b"\x00"
    rows = array.array("I")
    for name in names:
        rows.extend(table[name])
    header = GENRE_MAGIC + struct.pack("<IIII", 1, len(names), len(names_blob), len(rows))
    path = os.path.join(folder, "genres.bin")
    with open(path, "wb") as fh:
        fh.write(header)
        for values in (name_at, name_len, row_at, row_cnt):
            fh.write(array.array("I", values).tobytes())
        fh.write(bytes(names_blob))
        fh.write(rows.tobytes())
    return {"genre_bytes": os.path.getsize(path), "genres": len(names)}


def write_order(path, entries):
    """rows, years and scores for one prepared ordering: three aligned arrays.

    The Worker pages through these instead of the file order, so "newest" and
    "highest rated" cost a slice rather than a 245k-row sort per request.

    Version 2 adds the score, which is what lets two catalogues be ranked
    against each other: a page of "highest rated across the site" compares a
    mangaupdates 8.4 with an mgeko 3.6/5, and that needs both numbers, not just
    each shelf's own order.  Scores are hundredths of the shelf's own scale
    (rating x 10), so 8.4 -> 84 and 3.6/5 -> 72 once the scale is accounted for.
    """
    rows = array.array("I", [row for row, _, _ in entries])
    years = array.array("I", [year for _, year, _ in entries])
    scores = array.array("H", [score for _, _, score in entries])
    with open(path, "wb") as fh:
        fh.write(b"MKOR" + struct.pack("<III", 2, len(entries), 0))
        fh.write(rows.tobytes())
        fh.write(years.tobytes())
        fh.write(scores.tobytes())


def pack_shelf(name, path, min_fields, year_index=None, rating_index=None):
    extra = EXTRA_ROWS.get(name)
    if extra or name in VERBATIM_ROWS:
        if extra and not os.path.exists(extra):
            sys.exit(f"missing {extra}")
        folder = os.path.join(OUT, name)
        os.makedirs(folder, exist_ok=True)
        base_path = path
        path = os.path.join(folder, "rows.bin")
        with open(path, "wb") as out:
            for source_path in ((base_path, extra) if extra else (base_path,)):
                with open(source_path, "rb") as fh:
                    shutil.copyfileobj(fh, out)
    rows_bytes = os.path.getsize(path)
    offsets = array.array("I")
    title_at = array.array("I")
    lower = []
    idents = []
    order = []          # (row, year, rating, lowercased title) for the sorts
    ident_of = []      # row -> ident, for the sitemap and the meta join
    has_cover = bytearray()
    lower_units = 0
    pos = 0

    with open(path, "rb") as fh:
        for line in fh:
            start = pos
            pos += len(line)
            parts = line.rstrip(b"\n").split(b"\t")
            if len(parts) < min_fields:
                continue
            if not parts[0] or not parts[1]:
                continue
            row = len(offsets)
            title = parts[1].decode("utf-8")
            offsets.append(start)
            title_at.append(lower_units)
            low = title.lower() + "\n"
            lower.append(low)
            lower_units += utf16_len(low)
            ident = parts[0].decode("utf-8")
            ident_of.append(ident)
            # a cover column differs per shelf: mangadex and library proxy theirs,
            # mangaupdates hotlinks a CDN url, so "has one" is just "non-empty"
            cover_index = 2 if name != "mangaupdates" else 3
            has_cover.append(1 if len(parts) > cover_index and parts[cover_index].strip() else 0)
            if ident:
                idents.append((ident.encode("utf-8"), row))
            if year_index is not None:
                year = 0
                if len(parts) > year_index:
                    raw_year = parts[year_index].strip()
                    if raw_year.isdigit() and 1900 < int(raw_year) <= 2100:
                        year = int(raw_year)
                rating = 0.0
                if rating_index is not None and len(parts) > rating_index:
                    try:
                        rating = float(parts[rating_index])
                    except ValueError:
                        rating = 0.0
                order.append((row, year, rating, low[:-1]))

    offsets.append(rows_bytes)

    folder = os.path.join(OUT, name)
    os.makedirs(folder, exist_ok=True)

    header = MAGIC + struct.pack("<IIII", VERSION, len(title_at), rows_bytes, lower_units)
    with open(os.path.join(folder, "index.bin"), "wb") as fh:
        fh.write(header)
        fh.write(offsets.tobytes())
        fh.write(title_at.tobytes())

    text = "".join(lower).encode("utf-8")
    with open(os.path.join(folder, "lower.txt"), "wb") as fh:
        fh.write(text)

    # the same sorted id blob serve.py binary-searches for cover lookups
    idents.sort()
    buf, at, rows_at = bytearray(), array.array("I"), array.array("I")
    for ident_bytes, row in idents:
        at.append(len(buf))
        buf += ident_bytes
        buf += b"\n"
        rows_at.append(row)
    with open(os.path.join(folder, "ids.bin"), "wb") as fh:
        fh.write(bytes(buf))
    with open(os.path.join(folder, "ids.idx"), "wb") as fh:
        fh.write(struct.pack("<I", len(at)))
        fh.write(at.tobytes())
        fh.write(rows_at.tobytes())

    meta_stats = {}
    records = None
    if name in META_SOURCES:
        source = META_SOURCES[name]
        records = [None] * len(title_at)
        by_ident = {ident: row for row, ident in enumerate(ident_of) if ident}
        joined = 0
        with open(source["path"], encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    raw = json.loads(line)
                except ValueError:
                    continue
                row = by_ident.get(str(raw.get(source["key"]) or ""))
                if row is None or records[row] is not None:
                    continue
                record = meta_record(name, raw)
                if not record["g"] and not record["d"]:
                    continue
                records[row] = record
                joined += 1
        meta_stats = write_meta(folder, records, len(title_at))
        meta_stats.update(write_genres(folder, [record["g"] if record else [] for record in records]))
        meta_stats["joined"] = joined

    # What goes in the sitemap: not all 368k rows.  A brand new site that hands
    # a crawler its whole catalogue gets its thin pages ignored, and every one of
    # those fetches costs a request against the daily quota; a few thousand pages
    # that actually have a synopsis and a tag list earn their place first.
    candidates = []
    if name == "mangaupdates":
        for row, year, rating, _ in order:
            record = records[row] if records else None
            if not record or rating < 6.0 or not has_cover[row]:
                continue
            candidates.append(((-rating, -year, ident_of[row]), ident_of[row], record["u"]))
    elif name == "mangadex":
        for row, year, rating, _ in order:
            record = records[row] if records else None
            if not record or not record["d"] or not has_cover[row]:
                continue
            candidates.append(((-year, ident_of[row]), ident_of[row], record["u"]))
    candidates.sort(key=lambda entry: entry[0])

    sorted_files = {}
    if order:
        # newest first: undated rows are left out entirely, since "year 0" would
        # otherwise pile up at the end of a shelf that claims to be sorted by date
        fresh = sorted(
            ((row, year) for row, year, _, title in order if year),
            key=lambda pair: (-pair[1], order[pair[0]][3], pair[0]),
        )
        write_order(os.path.join(folder, "order-new.bin"),
                    [(row, year, 0) for row, year in fresh])
        sorted_files["new"] = len(fresh)

        rated = [(row, year, rating) for row, year, rating, _ in order if rating > 0]
        if rated:
            best = sorted(rated, key=lambda triple: (-triple[2], -triple[1], triple[0]))
            write_order(os.path.join(folder, "order-best.bin"),
                        [(row, year, int(round(rating * 10))) for row, year, rating in best])
            sorted_files["best"] = len(best)

    return {
        "orders": sorted_files,
        "meta": meta_stats,
        "sitemap": [(ident, lastmod) for _, ident, lastmod in candidates],
        "rows": len(title_at),
        "rows_bytes": rows_bytes,
        "lower_bytes": len(text),
        "lower_units": lower_units,
        "idents": len(at),
        "index_bytes": os.path.getsize(os.path.join(folder, "index.bin")),
    }


def load_info():
    """Chapter count, status and last-update stamp from chapter_scraper.py."""
    records = {}
    if not os.path.exists(INFO_PATH):
        return records
    with open(INFO_PATH, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except ValueError:
                continue
            slug = row.get("slug")
            if slug:
                records[slug] = row
    return records


def load_first_seen():
    """slug -> the epoch the catalogue first listed it, from catalog_scraper.py."""
    try:
        with open(FIRST_SEEN_PATH, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def pack_catalog():
    """The mgeko feed, flattened to the same row shape serve.py builds.

    The nightly chapter bake appends four fields after the badge: chapter count,
    status, last-update epoch and the epoch it was fetched.  A fifth says when
    the catalogue first listed the title, so the fresh shelf can carry a new
    series even before it has a chapter stamp.  A card can then paint its count
    and recency line before it asks the network anything.
    """
    info = load_info()
    first_seen = load_first_seen()
    rows = []
    with_info = 0
    with open(CATALOG_PATH, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                raw = json.loads(line)
            except ValueError:
                continue
            title = raw.get("title") or ""
            slug = raw.get("slug") or ""
            if not slug or not title:
                continue
            views = raw.get("views") or {}
            synopsis = (raw.get("description") or "").strip() or (raw.get("card_text") or "").strip()
            meta = info.get(slug) or {}
            chapters = int(meta.get("chapters") or 0)
            status = str(meta.get("status") or "")
            updated_at = int(meta.get("updated_at") or 0)
            fetched = int(meta.get("fetched") or 0)
            if chapters:
                with_info += 1
            rows.append([
                slug,
                title,
                raw.get("url") or (MGEKO_BASE + slug + "/"),
                raw.get("cover") or "",
                raw.get("rating"),
                views.get("weekly") or views.get("alltime") or 0,
                synopsis,
                raw.get("genres") or [],
                raw.get("badge") or "",
                chapters,
                status,
                updated_at,
                fetched,
                int(first_seen.get(slug) or 0),
            ])
    # The harvested titles ride along so the app's library tab stays one list.
    # They carry their reader path in field 14, which is what the per-title
    # indexes below use to stay mgeko-only (and small): by-slug, cards and the
    # updated feed skip them, while the rows themselves still ship as shards.
    # Parsing one 72k-row blob is what took the free-plan Worker past its CPU
    # limit, so nothing here is ever read as a whole file again.
    harvest_path = os.path.join(HERE, "output", "harvest.tsv")
    if os.path.exists(harvest_path):
        known = {row[0] for row in rows}
        with open(harvest_path, encoding="utf-8") as fh:
            for line in fh:
                parts = line.rstrip("\n").split("\t")
                if len(parts) < 5:
                    continue
                slug, title, cover, url, source = parts[:5]
                if not slug or not title or slug in known:
                    continue
                known.add(slug)
                chapters = int(parts[5]) if len(parts) > 5 and parts[5].isdigit() else 0
                updated = int(parts[6]) if len(parts) > 6 and parts[6].isdigit() else 0
                # only the chapter date goes in: first-seen is left 0 so a
                # title we merely discovered is not reported as updated
                rows.append([
                    slug, title, url, cover, None, 0, "", [], "",
                    chapters, "", updated, 0, 0,
                    "/reader/harvest/" + source + "/" + slug,
                ])

    rows.sort(key=lambda row: (row[1].lower(), row[0]))

    folder = os.path.join(OUT, "catalog")
    os.makedirs(folder, exist_ok=True)
    # rows.json is gone: it was the file every read parsed at once.  The
    # shards below are the feed now, and no route asks for the old object.
    payload = json.dumps(rows, ensure_ascii=False, separators=(",", ":")).encode("utf-8")

    # ---- sharded copies -------------------------------------------------
    # The Worker used to parse this whole array on every /api/catalog,
    # /api/fresh, /api/about and /api/story request.  At 7k rows with their
    # synopses that is tens of milliseconds of CPU, over the free plan's
    # budget, so a cold isolate answered 503 ("Exceeded CPU Limit").  The same
    # rows also ship as 256-row shards plus the small indexes those routes
    # actually need, so a page decodes one or two ~200 KB files instead.
    SHARD = 256

    def dump(name, data):
        with open(os.path.join(folder, name), "wb") as fh:
            fh.write(json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))

    # a shrunken catalogue must not leave yesterday's shards behind
    for name in os.listdir(folder):
        if re.fullmatch(r"shard-\d{3}\.json", name):
            os.remove(os.path.join(folder, name))
    for start in range(0, len(rows), SHARD):
        dump("shard-%03d.json" % (start // SHARD), rows[start:start + SHARD])
    dump("manifest.json", {"rows": len(rows), "shard": SHARD})
    # lowercased titles stay aligned to row numbers: search ranking reads only
    # this list, and a hit is a row number the shard reader can fetch
    dump("titles.json", [row[1].lower() for row in rows])
    # a harvested title is addressed as story/series, so only the mgeko rows
    # need a slug -> row table: 7k entries instead of 72k
    dump("by-slug.json", {row[0]: index for index, row in enumerate(rows) if len(row) == 14})
    # related rails only ever draw from the genre pools (mgeko rows), so the
    # card table is sparse instead of one entry per harvested title
    dump("cards.json", {str(index): [row[0], row[1], row[3] or ""]
                         for index, row in enumerate(rows) if len(row) == 14})
    genres = {}
    for index, row in enumerate(rows):
        for genre in row[7] or []:
            genres.setdefault(genre, []).append(index)
    dump("genres.json", genres)
    read_order = [(index, int(row[5] or 0)) for index, row in enumerate(rows)
                  if int(row[5] or 0) > 0]
    read_order.sort(key=lambda pair: (-pair[1], pair[0]))
    dump("read-order.json", [pair[0] for pair in read_order])
    # [stamp, row] newest first.  The Worker re-applies the 7-day cutoff on
    # every request, so a title that ages out between uploads still drops off.
    # An mgeko row may date from its chapter bake or from the day the catalogue
    # first listed it.  A harvested row only has the chapter date its crawler
    # observed (sitemap lastmod / Comick's newest chapter), so one without a
    # stamp stays out rather than pretending it moved today.
    cutoff = int(time.time()) - 7 * 86400
    fresh = [[max(int(row[11] or 0), int(row[13] or 0)), index]
             for index, row in enumerate(rows)
             if max(int(row[11] or 0), int(row[13] or 0)) >= cutoff
             and (len(row) == 14 or int(row[11] or 0) > 0)]
    fresh.sort(key=lambda pair: (-pair[0], pair[1]))
    dump("fresh.json", fresh)
    # /api/fresh then needs the row behind every stamp, and freshness has nothing
    # to do with row order: the newest ~1,250 titles live in all 284 shards, so
    # resolving fresh.json pulled the whole catalogue (~25 MB) on a cold colo and
    # the shelf took four seconds.  The same pairs ship with the row inlined --
    # one object, one read.
    dump("fresh-rows.json", [[stamp, rows[index]] for stamp, index in fresh])

    # the sitemap takes the most-read ones: views is the only popularity signal
    # mgeko publishes, and a title with none is nobody's search yet
    ranked = sorted((row for row in rows if row[3] and row[6]), key=lambda row: -int(row[5] or 0))
    return {"rows": len(rows), "bytes": len(payload), "with_chapters": with_info,
            "sitemap": [(row[0], "") for row in ranked]}


def pack_library_fresh():
    """Empty now that mangagg is not uploaded.

    /api/fresh used this to merge the other catalogue's last chapters into the
    updated feed.  With mangagg gone those slugs have no library row, so the
    feed is written empty instead of pointing the updated page at missing rows.
    """
    folder = os.path.join(OUT, "library")
    os.makedirs(folder, exist_ok=True)
    rows = []
    path = os.path.join(folder, "fresh.json")
    payload = json.dumps(rows, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    with open(path, "wb") as fh:
        fh.write(payload)
    return {"rows": len(rows), "bytes": len(payload)}


def xml_escape(text):
    return (str(text).replace("&", "&amp;").replace("<", "&lt;")
            .replace(">", "&gt;").replace('"', "&quot;").replace("'", "&apos;"))


def write_sitemaps(entries):
    """entries: [(shelf, ident, lastmod)] in priority order, already capped."""
    folder = os.path.join(OUT, "sitemap")
    os.makedirs(folder, exist_ok=True)
    for stale in os.listdir(folder):
        os.remove(os.path.join(folder, stale))

    def url_xml(shelf, ident, lastmod):
        return ("<url><loc>" + xml_escape(f"{SITE_ORIGIN}/t/{shelf}/{quote(ident, safe='')}") + "</loc>" +
                ("<lastmod>" + lastmod + "</lastmod>" if lastmod else "") + "</url>")

    files = []
    for start in range(0, len(entries), SITEMAP_CHUNK):
        chunk = entries[start:start + SITEMAP_CHUNK]
        name = f"sitemap-{len(files) + 1}.xml"
        body = ('<?xml version="1.0" encoding="UTF-8"?>'
                '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
                "".join(url_xml(*entry) for entry in chunk) + "</urlset>")
        path = os.path.join(folder, name)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(body)
        files.append((name, os.path.getsize(path)))

    index = ('<?xml version="1.0" encoding="UTF-8"?>'
             '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
             "".join("<sitemap><loc>" + xml_escape(f"{SITE_ORIGIN}/{name}") + "</loc></sitemap>"
                     for name, _ in files) + "</sitemapindex>")
    with open(os.path.join(folder, "sitemap.xml"), "w", encoding="utf-8") as fh:
        fh.write(index)
    return files, len(index)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--harvest-only", action="store_true",
                        help="rewrite just the library shelf and the catalog feed")
    args = parser.parse_args(argv)
    os.makedirs(OUT, exist_ok=True)
    summary = {"shelves": {}, "origin": SITE_ORIGIN}
    per_shelf = []
    shelves = [shelf for shelf in SHELVES if not args.harvest_only or shelf[0] == "library"]
    for name, path, min_fields, year_index, rating_index in shelves:
        if not os.path.exists(path):
            sys.exit(f"missing {path}")
        summary["shelves"][name] = pack_shelf(name, path, min_fields, year_index, rating_index)
        stats = summary["shelves"][name]
        orders = " ".join(f"{k}:{v:,}" for k, v in stats["orders"].items()) or "-"
        meta = stats["meta"]
        meta_line = (f"  meta {meta['joined']:,}/{stats['rows']:,} rows {meta['bytes'] / 1e6:.1f} MB"
                     if meta else "")
        print(f"{name:<13} {stats['rows']:>8,} rows  index {stats['index_bytes'] / 1e6:.1f} MB  "
              f"lower {stats['lower_bytes'] / 1e6:.1f} MB  ids {stats['idents']:,}  orders {orders}{meta_line}")
        per_shelf.append((name, stats["sitemap"]))

    summary["library_fresh"] = pack_library_fresh()
    fresh = summary["library_fresh"]
    print(f"library fresh {fresh['rows']:>8,} rows  {fresh['bytes'] / 1e6:.1f} MB")

    summary["catalog"] = pack_catalog()
    per_shelf.insert(0, ("catalog", summary["catalog"]["sitemap"]))
    print(f"catalog      {summary['catalog']['rows']:>8,} rows  "
          f"{summary['catalog']['bytes'] / 1e6:.1f} MB  "
          f"{summary['catalog']['with_chapters']:,} with chapters")

    if args.harvest_only:
        with open(os.path.join(OUT, "summary.json"), "w", encoding="utf-8") as fh:
            json.dump(summary, fh, indent=2)
        print("harvest-only: sitemap and the other shelves are left untouched")
        print(f"wrote {OUT}")
        return

    # 4k from each of the three shelves that carry a synopsis; the mangagg
    # library has no text at all, so its pages say noindex and stay out
    CAPS = {"catalog": 3000, "mangadex": 4000, "mangaupdates": 4000}
    entries = []
    for name, candidates in per_shelf:
        cap = CAPS.get(name, 0)
        taken = candidates[:cap]
        entries.extend((name, ident, lastmod) for ident, lastmod in taken)
        if cap:
            print(f"sitemap      {name:<12} {len(taken):,} of {len(candidates):,} titles")
    files, index_bytes = write_sitemaps(entries)
    summary["sitemap"] = {"urls": len(entries), "files": [name for name, _ in files],
                          "index_bytes": index_bytes}
    print(f"sitemap      {len(entries):,} urls in {len(files)} file(s) -> sitemap.xml")

    with open(os.path.join(OUT, "summary.json"), "w", encoding="utf-8") as fh:
        json.dump(summary, fh, indent=2)
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
