#!/usr/bin/env python3
"""Shard the harvested chapter lists for the reader.

kunmanga chapters are /manga/<slug>/chapter-<n> and bato1's are
/read/<slug>/chapter-<n>, so only the token is stored.  Comick identifies a
chapter by its hid and the reader fetches pages from the API by that hid, so
its entries keep [hid, chapter number] pairs for the picker label.

    harvest/ch/<source>-<shard>.json
    {"slug": {"t": title, "v": cover, "u": series page, "c": [...]}}

Run:  python3 cloud/build_harvest_chapters.py
"""

import json
import os
import re
import sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UI = os.path.join(os.path.dirname(HERE), "mgeko-tags-ui")
OUT = os.path.join(HERE, "cloud", "data", "harvest", "ch")
MANGAGG = os.path.join(HERE, "output", "mangagg.tsv")
FILES = [
    os.path.join(UI, "cache", "sources", "import.jsonl"),
    os.path.join(UI, "cache", "cron", "kunmanga.delta.jsonl"),
    os.path.join(UI, "cache", "sources", "comick.jsonl"),
]
SOURCES = {"kunmanga": "kun", "bato1": "bato", "comick": "comick"}
PRIMARY = {"kun": 0, "bato": 1, "comick": 2}

sys.path.insert(0, UI)
try:
    from crawl_sources import clean_title
except Exception:  # pragma: no cover
    def clean_title(title, slug=""):
        return " ".join(str(title or "").split())


def clean(text):
    return " ".join(str(text or "").split())


def slug_set(path):
    try:
        with open(path, encoding="utf-8") as fh:
            return {line.split("\t", 1)[0].strip() for line in fh if line.strip()}
    except OSError:
        return set()


def shard_of(slug):
    first = slug[:1].lower()
    return first if re.match(r"[a-z0-9]", first) else "_"


def number_key(label):
    match = re.match(r"([0-9]+)(?:[.-]([0-9]+))?", str(label))
    if not match:
        return (1, 0, 0, str(label))
    return (0, int(match.group(1)), float("0." + match.group(2)) if match.group(2) else 0, "")


def main():
    picked = {}
    order = []
    chapters = 0
    covered = slug_set(MANGAGG)
    covered_rows = 0

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
                # mangagg already serves this title and the harvest rows drop it,
                # so its shard entry would only be a second, conflicting copy
                if slug in covered:
                    covered_rows += 1
                    continue
                entries = []
                for chapter in rec.get("chapters") or []:
                    token = clean(chapter.get("n"))
                    if not token or "/" in token:
                        continue
                    if source == "comick":
                        entries.append((token, clean(chapter.get("label")) or token))
                        continue
                    url = str(chapter.get("u") or "")
                    if not (url.endswith("/chapter-" + token) or url.endswith("/chapter-" + token + "/")):
                        continue
                    entries.append((token, token))

                current = picked.get(slug)
                if current is None:
                    picked[slug] = {
                        "t": title,
                        "v": clean(rec.get("cover")),
                        "u": clean(rec.get("url")),
                        "source": source,
                        "c": dict(entries),
                    }
                    order.append(slug)
                elif current["source"] == source:
                    current["t"] = title or current["t"]
                    current["v"] = clean(rec.get("cover")) or current["v"]
                    current["u"] = clean(rec.get("url")) or current["u"]
                    current["c"].update(dict(entries))
                # a different source owns this slug already

    shards = {}
    records = 0
    for slug in order:
        item = picked[slug]
        entries = item["c"]
        if not entries:
            continue
        if item["source"] == "comick":
            listing = [list(pair) for pair in
                       sorted(entries.items(), key=lambda pair: number_key(pair[1]))]
        else:
            listing = sorted(entries.keys(), key=number_key)
        bucket = shards.setdefault(item["source"], {}).setdefault(shard_of(slug), {})
        bucket[slug] = {"t": item["t"], "v": item["v"], "u": item["u"], "c": listing}
        records += 1
        chapters += len(listing)

    if os.path.isdir(OUT):
        for name in os.listdir(OUT):
            if name.endswith(".json"):
                os.remove(os.path.join(OUT, name))
    os.makedirs(OUT, exist_ok=True)

    total = 0
    for source, buckets in shards.items():
        for shard, data in buckets.items():
            path = os.path.join(OUT, f"{source}-{shard}.json")
            payload = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            with open(path, "wb") as fh:
                fh.write(payload)
            total += len(payload)

    print(f"harvest reader  {records:,} titles  {chapters:,} chapters  "
          f"{sum(len(b) for b in shards.values())} shards  {total / 1e6:.1f} MB  "
          f"({covered_rows:,} mangagg -> {OUT})")


if __name__ == "__main__":
    main()
