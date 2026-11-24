#!/usr/bin/env python3
"""Crawl kunmanga and bato1 into one series record per title.

A record carries what the reader needs without a second request: title,
description, cover, every chapter URL, and the media policy that tells the
Worker how its pages must be served.

    kunmanga  pages sit on CDNs that answer only the bare origin referer
              ("https://www.kunmanga.online/"; the chapter URL and no referer
              are both 403), so the record names {"media": "kun"} and the
              Worker serves them through /img/kun/<host>/<path>.
    bato1     its CDN serves a hotlink with no referer, so {"media": "bato"}
              needs no proxy at all.

Neither series page lists its full history: kunmanga lazy-loads the chapter
list with JS, bato1 prints the recent 20.  Both publish every chapter in their
sitemap-chapter-* files, so those are streamed to a TSV, sorted with the system
sort and joined back onto the series rows.  A series page is still fetched for
the description and cover.

    python3 crawl_sources.py --source kun --chapters sitemap
    python3 crawl_sources.py --source bato --chapters sitemap
    python3 crawl_sources.py --source both --slugs /tmp/kun_uniq.tsv --limit 50

Output, under cache/sources/ by default:
    <source>.series.jsonl   one row per series page (the crawl's resume point)
    <source>.chapters.tsv   slug<TAB>token<TAB>lastmod, with --chapters sitemap
    <source>.jsonl          final records, chapters attached and ordered
    media.json              the per-source host/referer policy the reader reads
"""

import argparse
import gzip
import html
import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(HERE, "cache", "sources")

UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

# sustained rates measured against the live hosts: kunmanga 8.1 req/s put 108
# of 120 requests at 200, bato1 14.4 req/s put 120 of 120 at 200
RATES = {"kun": 8.0, "bato": 14.0}

KUN = "https://www.kunmanga.online"
BATO = "https://bato1.co.uk"

MEDIA = {
    "kun": {
        "source": "kunmanga",
        "mode": "proxy",
        "proxy": "/img/kun/",
        "referer": "https://www.kunmanga.online/",
        "hosts": ["img-r1.2xstorage.com", "cdn.zinmanga1.com", "cdn4.zinmanga1.com"],
        "attr": "data-src",
        "page_class": "wp-manga-chapter-img",
    },
    "bato": {
        "source": "bato1",
        "mode": "direct",
        "hosts": ["cdnb.snapvip.xyz", "cdna.snapvip.xyz"],
        "attr": "data-src",
    },
}

TAG_RE = re.compile(r"<[^>]+>")
WS_RE = re.compile(r"[ \t\r\f\v]+")
META_TAG_RE = re.compile(r"<meta\b[^>]*>", re.I)
SITEMAP_BLOCK_RE = re.compile(r"<(url|sitemap)\b[^>]*>([\s\S]*?)</\1>", re.I)
LOC_RE = re.compile(r"<loc>\s*([^<]+?)\s*</loc>", re.I)
LASTMOD_RE = re.compile(r"<lastmod>\s*([^<]+?)\s*</lastmod>", re.I)
CH_TOKEN_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$")
COVER_RE = re.compile(r"^https://[a-z0-9.-]+/.+\.(?:webp|jpe?g|png)$", re.I)

CHAPTER_LOC = {
    "kun": re.compile(r"/manga/([^/]+)/chapter-([^/?#]+)/?$"),
    "bato": re.compile(r"/read/([^/]+)/chapter-([^/?#]+)/?$"),
}
SERIES_LOC_RE = re.compile(r"/manga/([^/?#]+)/?$")

SERIES_URL = {"kun": KUN + "/manga/{}/", "bato": BATO + "/manga/{}?style=list"}
SITEMAP_INDEX = {"kun": KUN + "/sitemap.xml", "bato": BATO + "/sitemap.xml"}


def clean(fragment):
    text = TAG_RE.sub(" ", fragment or "")
    text = html.unescape(text).replace("\u00a0", " ")
    return WS_RE.sub(" ", text).strip()


def attr(tag_text, name):
    match = re.search(
        r"(?:^|\s)" + name + r"\s*=\s*(?:\"([^\"]*)\"|'([^']*)'|([^\s>]+))",
        tag_text,
        re.I,
    )
    if not match:
        return ""
    for value in match.groups():
        if value is not None:
            return value
    return ""


def meta_content(page, key):
    for tag in META_TAG_RE.findall(page):
        name = (attr(tag, "property") or attr(tag, "name") or "").lower()
        if name == key.lower():
            return html.unescape(attr(tag, "content")).strip()
    return ""


def first_block(page, patterns):
    for pattern in patterns:
        match = re.search(pattern, page, re.I | re.S)
        if match:
            value = clean(match.group(1))
            if value:
                return value
    return ""


# og:title is a page title, not a series title: kunmanga appends "Latest Chap
# Free On ZinManga" to all 96,905 of them and bato wraps the name in
# "Read ... Online - All Chapters".  Left in, every imported title reads like an
# advert.
TITLE_NOISE = (
    r"^Read\s+",
    r"\s+Latest\s+Chaps?(?:ter)?\s+Free\s+On\s+(?:ZinManga|KunManga)\s*$",
    r"\s+Online\s+Free\s+On\s+\S+\s*$",
    r"\s+Online\s*[-–]\s*All\s+Chapters\s*$",
    r"\s*[-–|]\s*(?:KunManga|ZinManga|BATO)\s*$",
)


def clean_title(title, slug=""):
    text = html.unescape(title or "").strip()
    for _ in range(3):
        before = text
        for pattern in TITLE_NOISE:
            text = re.sub(pattern, "", text, flags=re.I).strip()
        if text == before:
            break
    text = re.sub(r"\s{2,}", " ", text).strip(" -–|:")
    return text or (slug.replace("-", " ").title() if slug else "")


def fetch(url, accept="text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          timeout=45, retries=3):
    """One GET, gzip-aware. 404/410 return at once; 429/403/503 back off.

    Sitemap chapter files are served as .xml.gz with no Content-Encoding, so
    the gzip magic is checked as well as the header.
    """
    headers = {
        "User-Agent": UA,
        "Accept": accept,
        "Accept-Encoding": "gzip",
        "Accept-Language": "en-US,en;q=0.9",
    }
    last = None
    for attempt in range(retries):
        try:
            request = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(request, timeout=timeout) as response:
                raw = response.read()
                if (response.headers.get("Content-Encoding") or "").lower() == "gzip":
                    try:
                        raw = gzip.decompress(raw)
                    except OSError:
                        pass
                if raw[:2] == b"\x1f\x8b":
                    try:
                        raw = gzip.decompress(raw)
                    except OSError:
                        pass
                return response.status, raw.decode("utf-8", "replace")
        except urllib.error.HTTPError as err:
            last = err
            if err.code in (404, 410):
                return err.code, ""
            if err.code in (403, 429, 500, 502, 503, 504):
                time.sleep(1.5 * (attempt + 1))
        except Exception as err:  # timeouts, resets, DNS
            last = err
            time.sleep(1.0 * (attempt + 1))
    return (getattr(last, "code", 0) or 0), ""


class RateLimiter:
    """A shared spacing gate: `gap` seconds between request starts, any thread."""

    def __init__(self, per_second):
        self.gap = 1.0 / float(per_second)
        self.lock = threading.Lock()
        self.next_at = 0.0

    def wait(self):
        with self.lock:
            now = time.monotonic()
            at = max(now, self.next_at)
            self.next_at = at + self.gap
        if at > now:
            time.sleep(at - now)


def sitemap_entries(xml, with_lastmod=False):
    """Both <url> and <sitemap> entries: the index uses the latter."""
    out = []
    for _, block in SITEMAP_BLOCK_RE.findall(xml or ""):
        loc = LOC_RE.search(block)
        if not loc:
            continue
        stamp = ""
        if with_lastmod:
            match = LASTMOD_RE.search(block)
            stamp = match.group(1).strip() if match else ""
        out.append((html.unescape(loc.group(1)).strip(), stamp))
    return out


def chapter_key(token):
    match = re.match(r"^(\d+)(?:[.-](\d+))?(.*)$", token)
    if not match:
        return (10 ** 9, 0, token)
    return (int(match.group(1)), int(match.group(2) or 0), match.group(3))


def chapter_url(source, slug, token):
    if source == "kun":
        return KUN + "/manga/" + slug + "/chapter-" + token
    return BATO + "/read/" + slug + "/chapter-" + token


def record(source, slug, title, desc, cover, chapters, url):
    tokens = sorted({t for t in chapters if CH_TOKEN_RE.match(t)}, key=chapter_key)
    return {
        "source": "kunmanga" if source == "kun" else "bato1",
        "slug": slug,
        "title": title or slug.replace("-", " ").title(),
        "desc": desc,
        "cover": cover,
        "url": url,
        "media": source,
        "chapters": [{"n": t, "u": chapter_url(source, slug, t)} for t in tokens],
    }


# ---------- series pages ----------

KUN_DESC_PATTERNS = (
    r'<div[^>]+class="[^"]*(?:summary__content|description-summary)[^"]*"[^>]*>([\s\S]*?)</div>',
    r'<div[^>]+itemprop="description"[^>]*>([\s\S]*?)</div>',
)
BATO_DESC_PATTERNS = (
    r'<div[^>]+class="[^"]*(?:comic-desc|summary|description|synopsis)[^"]*"[^>]*>([\s\S]*?)</div>',
    r'<p[^>]+class="[^"]*(?:comic-desc|summary|synopsis)[^"]*"[^>]*>([\s\S]*?)</p>',
)


def parse_kun_series(slug, page):
    title = clean_title(meta_content(page, "og:title"), slug)
    desc = first_block(page, KUN_DESC_PATTERNS)
    cover = meta_content(page, "og:image")
    if not COVER_RE.match(cover or ""):
        # 54 series pages publish a bare CDN host as og:image; every real cover
        # is the thumb path, so rebuild it from the slug
        cover = "https://cdn3.zinmanga1.com//thumb/" + slug + ".webp"
    tokens = []
    seen = set()
    pattern = re.compile(
        r"href=[\"'](?:https://www\.kunmanga\.online)?/manga/" + re.escape(slug) +
        r"/chapter-([^\"'?#/]+)/?[\"']",
        re.I,
    )
    for match in pattern.finditer(page):
        token = html.unescape(match.group(1))
        if token in seen:
            continue
        seen.add(token)
        tokens.append(token)
    return record("kun", slug, title, desc, cover, tokens, KUN + "/manga/" + slug + "/")


def parse_bato_series(slug, page):
    title = clean_title(meta_content(page, "og:title"), slug)
    desc = first_block(page, BATO_DESC_PATTERNS)
    cover = ""
    backdrop = re.search(r"background-image:\s*url\(['\"]?([^'\")]+)", page, re.I)
    if backdrop:
        cover = html.unescape(backdrop.group(1)).strip()
    if not cover:
        cover = meta_content(page, "og:image")
    if not COVER_RE.match(cover or ""):
        cover = "https://cdnb.snapvip.xyz/thumb/" + slug + ".webp"
    tokens = []
    seen = set()
    pattern = re.compile(r"/read/" + re.escape(slug) + r"/chapter-([^\"'/?#]+)", re.I)
    for match in pattern.finditer(page):
        token = html.unescape(match.group(1))
        if token in seen:
            continue
        seen.add(token)
        tokens.append(token)
    for token in re.findall(r'"chapter-([A-Za-z0-9._-]+)"\s*:', page):
        if token not in seen:
            seen.add(token)
            tokens.append(token)
    return record("bato", slug, title, desc, cover, tokens, BATO + "/manga/" + slug)


# ---------- sitemaps ----------

def sitemap_children(source):
    status, xml = fetch(SITEMAP_INDEX[source], accept="application/xml")
    if status != 200:
        raise SystemExit("%s sitemap index: HTTP %s" % (source, status))
    return [loc for loc, _ in sitemap_entries(xml)]


def discover_slugs(source, limit=0):
    """Every series slug the sitemaps publish."""
    children = [u for u in sitemap_children(source) if "sitemap-chapter" not in u]
    limiter = RateLimiter(RATES[source] + 4)
    found = set()
    with ThreadPoolExecutor(max_workers=6) as pool:
        def work(url):
            limiter.wait()
            status, body = fetch(url, accept="application/xml")
            if status != 200:
                return []
            return [loc for loc, _ in sitemap_entries(body)]

        for index, future in enumerate(as_completed([pool.submit(work, u) for u in children]), 1):
            for loc in future.result():
                match = SERIES_LOC_RE.search(loc)
                if match:
                    found.add(match.group(1))
            if index % 20 == 0:
                print("  sitemap %d/%d, %d slugs" % (index, len(children), len(found)), flush=True)
    slugs = sorted(found)
    return slugs[:limit] if limit else slugs


def crawl_chapters(source, wanted, out_path, workers=8, files=0):
    """Stream sitemap-chapter-* into slug/token/lastmod rows.

    `files` limits the walk to the newest N children (0 = all).  The tail of
    kunmanga's list is the recent end, so a short window is a cheap refresh;
    a full crawl passes 0.
    """
    children = [u for u in sitemap_children(source) if "sitemap-chapter" in u]
    if files:
        children = children[-files:]
    if not children:
        raise SystemExit("%s: no sitemap-chapter-* children" % source)
    if os.path.exists(out_path) and os.path.getsize(out_path) > 0:
        print("%s chapters: %s already has data, keeping it" % (source, out_path), flush=True)
        return out_path

    limiter = RateLimiter(RATES[source] + 4)
    pattern = CHAPTER_LOC[source]
    lock = threading.Lock()
    total = 0
    started = time.time()
    # a walk is thousands of files long; a partial file left by a kill must not
    # look like a finished one, so it is renamed into place only at the end
    part_path = out_path + ".part"

    with open(part_path, "w", encoding="utf-8") as out:
        def work(url):
            limiter.wait()
            status, xml = fetch(url, accept="application/xml")
            if status != 200:
                return 0
            rows = []
            for loc, stamp in sitemap_entries(xml, with_lastmod=True):
                match = pattern.search(loc)
                if not match:
                    continue
                slug, token = match.group(1), html.unescape(match.group(2))
                if wanted is not None and slug not in wanted:
                    continue
                if not CH_TOKEN_RE.match(token):
                    continue
                rows.append((slug, token, stamp))
            with lock:
                for slug, token, stamp in rows:
                    out.write(slug + "\t" + token + "\t" + stamp + "\n")
            return len(rows)

        with ThreadPoolExecutor(max_workers=workers) as pool:
            for index, future in enumerate(as_completed([pool.submit(work, u) for u in children]), 1):
                total += future.result()
                if index % 20 == 0:
                    print("  chapter sitemap %d/%d, %d rows" % (index, len(children), total), flush=True)

    os.replace(part_path, out_path)
    print("%s chapters: %d rows in %.1fs" % (source, total, time.time() - started), flush=True)
    return out_path


# ---------- crawling and assembly ----------

def load_done(path):
    done = set()
    if not os.path.exists(path):
        return done
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            try:
                done.add(json.loads(line)["slug"])
            except Exception:
                continue
    return done


def crawl_series(source, slugs, out_path, limit=0, workers=10):
    limiter = RateLimiter(RATES[source])
    parse = parse_kun_series if source == "kun" else parse_bato_series
    template = SERIES_URL[source]

    done = load_done(out_path)
    todo = [slug for slug in slugs if slug not in done]
    if limit:
        todo = todo[:limit]
    print("%s: %d slugs, %d already done, %d to fetch" % (source, len(slugs), len(done), len(todo)), flush=True)
    if not todo:
        return 0

    saved = 0
    failures = 0
    started = time.time()
    with open(out_path, "a", encoding="utf-8") as out, ThreadPoolExecutor(max_workers=workers) as pool:
        def work(slug):
            limiter.wait()
            status, page = fetch(template.format(slug))
            if status != 200 or not page:
                return None, slug, status
            return parse(slug, page), slug, status

        futures = [pool.submit(work, slug) for slug in todo]
        miss_rows = []
        for index, future in enumerate(as_completed(futures), 1):
            try:
                item, miss_slug, miss_status = future.result()
            except Exception:
                item, miss_slug, miss_status = None, "", 0
            if not item:
                failures += 1
                if miss_slug:
                    miss_rows.append((miss_slug, miss_status))
            else:
                out.write(json.dumps(item, ensure_ascii=False) + "\n")
                out.flush()
                saved += 1
            if index % 250 == 0:
                rate = index / max(0.001, time.time() - started)
                print("  %d/%d  saved=%d miss=%d  %.1f req/s" % (index, len(todo), saved, failures, rate), flush=True)
    # a miss is only useful if the next pass can name it; retry_misses.py reads
    # this file, and without it the backfill knows a count but not the slugs
    miss_path = out_path.replace(".series.jsonl", ".misses.tsv")
    with open(miss_path, "w", encoding="utf-8") as handle:
        for slug, status in miss_rows:
            handle.write("%s\t%s\n" % (slug, status))
    elapsed = time.time() - started
    print("%s: saved %d, missed %d (listed in %s) in %.1fs"
          % (source, saved, failures, miss_path, elapsed), flush=True)
    return saved


def assemble(source, series_path, chapters_path, out_path):
    """Join the sorted chapter TSV onto the series rows, one record at a time."""
    meta = {}
    order = []
    with open(series_path, encoding="utf-8") as handle:
        for line in handle:
            try:
                item = json.loads(line)
            except Exception:
                continue
            slug = item.get("slug")
            if not slug or slug in meta:
                continue
            meta[slug] = item
            order.append(slug)

    rows = None
    if chapters_path and os.path.exists(chapters_path):
        sorted_path = chapters_path + ".sorted"
        print("sorting %s ..." % chapters_path, flush=True)
        subprocess.run(
            ["sort", "-t", "\t", "-k1,1", "-k2,2V", chapters_path, "-o", sorted_path],
            check=True,
        )
        rows = sorted_path

    def write(item, tokens):
        merged = record(source, item["slug"], item.get("title"), item.get("desc"),
                        item.get("cover"), tokens,
                        item.get("url") or (KUN + "/manga/" + item["slug"] + "/" if source == "kun"
                                            else BATO + "/manga/" + item["slug"]))
        handle.write(json.dumps(merged, ensure_ascii=False) + "\n")

    with open(out_path, "w", encoding="utf-8") as handle:
        written = 0
        seen = set()
        if rows:
            current = None
            tokens = []
            with open(rows, encoding="utf-8") as source_rows:
                for line in source_rows:
                    parts = line.rstrip("\n").split("\t")
                    if len(parts) < 2:
                        continue
                    slug, token = parts[0], parts[1]
                    if current is not None and slug != current:
                        item = meta.get(current)
                        if item:
                            write(item, tokens)
                            written += 1
                        tokens = []
                    current = slug
                    tokens.append(token)
                if current is not None:
                    item = meta.get(current)
                    if item:
                        write(item, tokens)
                        written += 1
            if rows:
                with open(rows, encoding="utf-8") as source_rows:
                    for line in source_rows:
                        seen.add(line.split("\t", 1)[0])
        # series the chapter sitemaps did not mention keep what the page offered
        for slug in order:
            if slug in seen:
                continue
            item = meta[slug]
            write(item, [c["n"] for c in item.get("chapters") or []])
            written += 1
    print("assembled %d %s records into %s" % (written, source, out_path), flush=True)
    return written


def read_slugs(path):
    wanted = set()
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            wanted.add(line.split("\t")[0].split(" ")[0])
    return wanted


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", choices=["kun", "bato", "both"], default="both")
    parser.add_argument("--chapters", choices=["sitemap", "page", "none"], default="sitemap",
                        help="sitemap = full history from the chapter sitemaps, page = only what the series page prints")
    parser.add_argument("--slugs", help="restrict to the slugs in this file (one per line)")
    parser.add_argument("--limit", type=int, default=0, help="fetch at most N series")
    parser.add_argument("--workers", type=int, default=10)
    parser.add_argument("--chapter-files", type=int, default=0,
                        help="walk only the newest N chapter sitemaps (0 = all)")
    parser.add_argument("--out", default=OUT_DIR)
    parser.add_argument("--assemble-only", action="store_true")
    args = parser.parse_args(argv)

    if args.slugs and args.source == "both":
        raise SystemExit("--slugs names one source's slugs; run --source kun and --source bato separately")

    os.makedirs(args.out, exist_ok=True)
    wanted = read_slugs(args.slugs) if args.slugs else None
    if wanted is not None:
        print("restricted to %d slugs from %s" % (len(wanted), args.slugs), flush=True)

    with open(os.path.join(args.out, "media.json"), "w", encoding="utf-8") as handle:
        json.dump(MEDIA, handle, indent=2)
        handle.write("\n")

    for source in (("kun", "bato") if args.source == "both" else (args.source,)):
        series_path = os.path.join(args.out, source + ".series.jsonl")
        final_path = os.path.join(args.out, source + ".jsonl")
        chapters_path = os.path.join(args.out, source + ".chapters.tsv")
        if not args.assemble_only:
            slugs = sorted(wanted) if wanted else discover_slugs(source, limit=args.limit)
            crawl_series(source, slugs, series_path, limit=args.limit, workers=args.workers)
            if args.chapters == "sitemap":
                crawl_chapters(source, wanted, chapters_path, files=args.chapter_files)
        assemble(source, series_path, chapters_path if args.chapters == "sitemap" else None, final_path)


if __name__ == "__main__":
    main()
