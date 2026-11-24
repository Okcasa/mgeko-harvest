#!/usr/bin/env python3
"""Comick: refresh the titles that uploaded a chapter in the last N days.

Comick's recent-chapter feed is one request, and every row carries the comic's
slug, so a run is:

    /chapter?lang=en           -> the newest chapters, newest first
    /comic/<hid>/chapters      -> that comic's full English chapter list
    /comic/<slug>              -> title, synopsis, cover, genre names

Only comics with a chapter inside the window are touched, so the first run
fills in name, cover, description, tags and every chapter for everything
currently active, and later runs rewrite only the titles that moved.

    python3 cron_comick.py                 # last 3 days
    python3 cron_comick.py --days 10       # wider backfill window
    python3 cron_comick.py --dry-run       # say what would be fetched
    python3 cron_comick.py --max 50        # bounded run
"""

import argparse
import datetime as dt
import json
import os
import sys
import time
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "cache", "sources", "comick.jsonl")
STATE = os.path.join(HERE, "cache", "cron", "comick.json")

API = "https://api.comick.dev"
SITE = "https://comick.dev"
UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
      "Chrome/124.0.0.0 Safari/537.36")
RATE = 0.25  # seconds between API calls, ~4 req/s


def clean(text):
    return " ".join(str(text or "").split())


def get(url, retries=3):
    last = None
    for attempt in range(retries):
        request = urllib.request.Request(url, headers={
            "User-Agent": UA,
            "Accept": "application/json",
        })
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return json.loads(response.read().decode("utf-8"))
        except Exception as err:  # noqa: BLE001 - retried, then reported
            last = err
            time.sleep(1.5 * (attempt + 1))
    raise last


def iso_epoch(value):
    try:
        parsed = dt.datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    return int(parsed.timestamp())


def cover_of(comic):
    url = clean(comic.get("cover_url"))
    if url.startswith("http"):
        return url
    for cover in comic.get("md_covers") or []:
        key = clean(cover.get("b2key"))
        if key:
            return "https://meo.comick.pictures/" + key
    return ""


def genres_of(comic):
    names = []
    for entry in comic.get("md_comic_md_genres") or []:
        genre = entry.get("md_genres") if isinstance(entry, dict) else None
        name = clean((genre or {}).get("name"))
        if name and name not in names:
            names.append(name)
    return names


def chapter_rank(chapter):
    try:
        return (0, float(str(chapter.get("label") or "")), "")
    except ValueError:
        return (1, 0.0, str(chapter.get("label") or ""))


def comic_record(slug, hid, delay):
    detail = get(API + "/comic/" + urllib.parse.quote(slug) + "?tachiyomi=true")
    comic = detail.get("comic") or {}
    time.sleep(delay)
    listed = get(API + "/comic/" + hid + "/chapters?lang=en&page=0&limit=10000")
    rows = []
    seen = set()
    for chapter in (listed.get("chapters") if isinstance(listed, dict) else listed) or []:
        token = clean(chapter.get("hid"))
        label = clean(chapter.get("chap"))
        if not token or token in seen:
            continue
        if chapter.get("lang") and chapter.get("lang") != "en":
            continue
        seen.add(token)
        rows.append({"n": token, "label": label or token,
                     "u": SITE + "/comic/" + slug + "/" + token + "-chapter-" + (label or "1") + "-en"})
    rows.sort(key=chapter_rank)
    return {
        "source": "comick",
        "slug": slug,
        "title": clean(comic.get("title")) or slug.replace("-", " ").title(),
        "desc": clean(comic.get("desc")),
        "cover": cover_of(comic),
        "url": SITE + "/comic/" + slug,
        "media": "comick",
        "genres": genres_of(comic),
        "chapters": rows,
    }


def load_records():
    records = {}
    if not os.path.exists(OUT):
        return records
    with open(OUT, encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except ValueError:
                continue
            slug = clean(row.get("slug"))
            if slug:
                records[slug] = row
    return records


def save_records(records):
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    tmp = OUT + ".tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        for slug in sorted(records):
            handle.write(json.dumps(records[slug], ensure_ascii=False) + "\n")
    os.replace(tmp, OUT)


def recent_comics(days, pages):
    cutoff = int((dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=days)).timestamp())
    found = {}
    newest = 0
    for page in range(max(1, pages)):
        feed = get(API + "/chapter?lang=en&page=" + str(page) + "&limit=100")
        if not isinstance(feed, list) or not feed:
            break
        for row in feed:
            if row.get("external_type"):
                continue
            stamp = iso_epoch(row.get("last_at") or row.get("created_at"))
            if stamp is None:
                continue
            newest = max(newest, stamp)
            if stamp < cutoff:
                continue
            comic = row.get("md_comics") or {}
            slug = clean(comic.get("slug"))
            hid = clean(comic.get("hid"))
            if slug and hid:
                found[slug] = hid
        time.sleep(RATE)
        oldest = iso_epoch(feed[-1].get("last_at") or feed[-1].get("created_at"))
        if oldest is not None and oldest < cutoff:
            break
    return found, newest


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--days", type=int, default=3)
    parser.add_argument("--pages", type=int, default=5)
    parser.add_argument("--max", type=int, default=400)
    parser.add_argument("--out", default=OUT)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)

    started = time.time()
    wanted, newest = recent_comics(args.days, args.pages)
    print("comick: %d comics with a chapter in the last %d day(s)"
          % (len(wanted), args.days), flush=True)
    if args.dry_run:
        for slug in list(wanted)[:20]:
            print("  " + slug)
        print("dry run: nothing fetched")
        return 0

    if len(wanted) > args.max:
        print("capping at %d of %d; the rest wait for the next run"
              % (args.max, len(wanted)), flush=True)
        wanted = dict(list(wanted.items())[:args.max])

    records = load_records()
    saved = 0
    failed = 0
    for index, (slug, hid) in enumerate(wanted.items(), 1):
        try:
            records[slug] = comic_record(slug, hid, RATE)
            saved += 1
        except Exception as err:  # noqa: BLE001 - one title must not stop the run
            failed += 1
            print("  ! %s: %s" % (slug, err), file=sys.stderr, flush=True)
        if index % 25 == 0:
            save_records(records)
            print("  %d/%d saved=%d failed=%d" % (index, len(wanted), saved, failed), flush=True)

    save_records(records)
    state = {
        "checked": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat(),
        "days": args.days,
        "newest_chapter": newest,
        "touched": len(wanted),
        "records": len(records),
    }
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    with open(STATE + ".tmp", "w", encoding="utf-8") as handle:
        json.dump(state, handle, indent=1, sort_keys=True)
    os.replace(STATE + ".tmp", STATE)

    elapsed = time.time() - started
    print("comick done: %d refreshed, %d failed, %d records, %.1fs"
          % (saved, failed, len(records), elapsed))
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
