/**
 * mgeko tag wall, on Workers + R2.
 *
 * This is serve.py ported: the four shelves keep the same search and paging
 * behaviour, rows are still read as byte ranges out of the original TSV, and
 * the two cover proxies behave the same way.  The differences are forced by
 * the platform:
 *
 *   - there is no filesystem, so the TSVs and their offset indexes live in R2
 *     and are read with ranged GETs;
 *   - there is no long-lived process, so a shelf's index and title blob are
 *     loaded on first use and memoised in the isolate (and in the colo cache);
 *   - covers are cached by the edge rather than on disk.
 *
 * The wall itself is served by Workers static assets.  The Worker handles the
 * JSON API, the per-title pages (/t/<shelf>/<id>), the visit counter and the
 * sitemaps.
 */

import { titlePage, notFoundPage, shelfInfo } from "./pages.js";
import { parseChapter, chapterFromUrl, readerPage } from "./reader.js";

const SHELVES = {
  series: {
    name: "library",
    base: "https://mangagg.com/comic/",
    minFields: 3,
    ids: true,
    sorts: [],
  },
  mangadex: {
    name: "mangadex",
    base: "https://mangadex.org/title/",
    minFields: 6,
    ids: true,
    sorts: ["new"],
  },
  mangaupdates: {
    name: "mangaupdates",
    base: "",
    minFields: 8,
    /* no cover proxy here, so the id index is only needed for title pages and
       is fetched on demand rather than on a shelf's first page */
    ids: false,
    sorts: ["new", "best"],
  },
};

const MGEKO_BASE = "https://www.mgeko.cc/manga/";
const SYNOPSIS_PREVIEW = 320;
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,400}$/;

const COVER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36",
  Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
  Referer: "https://mangagg.com/",
};
// MangaDex's image edge challenges anything that looks like a browser: a Chrome
// UA is answered with a 302 to /edge/challenge whatever the referer says, which
// is why every proxied cover came back empty -- the .256/.512 thumbnails were
// there all along.  A client that identifies itself honestly is served them, so
// the proxy asks for the 42 KB thumbnail as before and keeps the original as the
// last resort.
const DEX_COVER_HEADERS = {
  "User-Agent": "mgeko-tags/1.0 (+https://mgeko-tags.okcasa27.workers.dev)",
  Accept: "image/avif,image/webp,image/png,image/jpeg,*/*;q=0.8",
};
const DEX_COVER_VARIANTS = [".256.jpg", ".512.jpg", ""];

/* ---------- chapter image proxy ----------
   kunmanga's page CDNs answer exactly one referer: the bare origin
   "https://www.kunmanga.online/".  The chapter URL as referer is a 403 and no
   referer is a 403, so a reader on this origin cannot hotlink a page at all.
   Every page therefore comes through here: the upstream fetch carries that
   referer, the bytes are cached in R2 under a hash of their upstream URL, and
   the app only ever sees /img/kun/<host>/<path>.

   The host is the allowlist.  Only the three CDNs below resolve, so the route
   is not an open proxy, and bato1 -- whose CDN serves a hotlink with no referer
   -- needs none of this. */
const IMAGE_SOURCES = {
  kun: {
    referer: "https://www.kunmanga.online/",
    hosts: [
      "img-r1.2xstorage.com",
      "img-r2.2xstorage.com",
      "cdn.zinmanga1.com",
      "cdn3.zinmanga1.com",
      "cdn4.zinmanga1.com",
    ],
  },
  /* comick's page CDN only answers a request whose Referer is comick.live, so
     the proxy supplies that header instead of hotlinking from our own pages */
  comick: {
    referer: "https://comick.live/",
    hosts: ["cdn1.comicknew.pictures", "cdn2.comicknew.pictures"],
  },
};

const IMAGE_EXT_RE = /\.(?:webp|jpe?g|png|gif|avif)$/i;
const IMAGE_PATH_RE = /^[A-Za-z0-9._~!$&'()*+,;=:@%\/-]+$/;
const IMAGE_MAX_BYTES = 8 * 1024 * 1024;   // a webtoon strip, not a scan archive
const IMAGE_LIMIT = 1200;                  // pages per minute per address
const IMAGE_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
  "Sec-Fetch-Dest": "image",
  "Sec-Fetch-Mode": "no-cors",
  "Sec-Fetch-Site": "cross-site",
};

/**
 * Resolve /img/<source>/<host>/<path> to an upstream URL, or null.
 *
 * `..` is refused rather than normalised: a normalised path could climb off
 * the allowlisted host, which is the one thing this route must never allow.
 * The doubled slash in cdn.zinmanga1.com//zin/... is real and is preserved.
 */
export function imageProxyTarget(source, tail) {
  const spec = IMAGE_SOURCES[source];
  if (!spec) return null;
  const slash = tail.indexOf("/");
  if (slash <= 0) return null;
  const host = tail.slice(0, slash).toLowerCase();
  const path = tail.slice(slash);
  if (!spec.hosts.includes(host)) return null;
  if (path.length > 700 || path.includes("..")) return null;
  if (!IMAGE_PATH_RE.test(path)) return null;
  if (!IMAGE_EXT_RE.test(path)) return null;
  return { source: source, url: "https://" + host + path, referer: spec.referer };
}

/* ---------- the series page ----------
   mgeko renders its series pages as plain HTML, and their header carries what a
   card cannot: chapter count, a status word and "Last Update".  One fetch per
   title, edge-cached for hours, is all the info route needs. */
const READER_HEADERS = {
  "User-Agent": "mgeko-tags/1.0 (+https://mgeko-tags.okcasa27.workers.dev)",
  Accept: "text/html,application/xhtml+xml",
};
const READER_TIMEOUT = 9000;

const MAGIC = 0x58494b4d; // "MKIX" little endian

/** Percent-encode like Python's urllib.parse.quote (safe="/"). */
function pyQuote(text) {
  return encodeURIComponent(text).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

function normalize(query) {
  return String(query || "").trim().toLowerCase().replace(/\s+/g, " ").slice(0, 200);
}

function text(bytes) {
  return new TextDecoder("utf-8").decode(bytes);
}

/* ---------- loading from R2 ---------- */

const memory = new Map();   // survives between requests in the same isolate
const readerChunks = new Map();  // parsed reader/<letter>.json, cleared with it

/* How long a copy of an R2 object stays authoritative here.
 *
 * A search reads a multi-megabyte title blob, and on a cold colo that read can
 * pause long enough that the shelf looks frozen.  Keying the edge cache by a
 * per-isolate five-minute epoch made every isolate fetch its own copy every
 * five minutes; the uploader now writes a version stamp last, and the stamp is
 * the cache key.  Every isolate in a colo then shares one copy per upload, and
 * a refresh still lands without a deploy.  Without a stamp (an older upload)
 * the timed sweep remains as a fallback. */
const DATA_TTL_MS = 3600000;      // fallback sweep when the bucket has no stamp
const VERSION_TTL_MS = 60000;     // how often to look for a new stamp
const CACHE_TTL_MS = 86400000;    // stamped keys never change under a version
const epochBase = Date.now();
let dataEpoch = 0;
let dataVersion = null;
let versionCheckedAt = 0;

async function readDataVersion(env) {
  try {
    /* a stalled stamp read must not hold every request in the isolate: the
       fallback sweep is good enough until the next check a minute later */
    const obj = await Promise.race([
      env.BUCKET.get("version.json"),
      new Promise((resolve) => setTimeout(() => resolve(null), 2500)),
    ]);
    if (!obj) return null;
    const parsed = JSON.parse(text(new Uint8Array(await obj.arrayBuffer())));
    return parsed && parsed.version ? String(parsed.version) : null;
  } catch (err) {
    return null;
  }
}

/* Called once per request, before anything is read.  When the stamp or the
   fallback window rolls, the isolate drops every raw file and every structure
   parsed from one together, so an index and the bytes it came from can never
   disagree. */
async function sweepData(env) {
  let rolled = false;
  if (Date.now() - versionCheckedAt >= VERSION_TTL_MS) {
    versionCheckedAt = Date.now();
    const version = await readDataVersion(env);
    if (version && version !== dataVersion) {
      dataVersion = version;
      rolled = true;
    }
  }
  if (rolled || Date.now() - epochBase >= (dataEpoch + 1) * DATA_TTL_MS) {
    dataEpoch += 1;
    memory.clear();
    readerChunks.clear();
  }
}

async function objectBytes(env, key) {
  const obj = await env.BUCKET.get(key);
  if (!obj) throw new Error("missing R2 object " + key);
  return new Uint8Array(await obj.arrayBuffer());
}

/**
 * Bytes for one R2 key, through the colo cache first.
 *
 * The two search files of a shelf are a few megabytes each and change only
 * when the data is re-uploaded, so a cache miss that reaches R2 is rare after
 * the first reader in a colo.
 */
/* Concurrent callers inside one request -- a title page asks for the index, the
   id index, the meta table and the genre index at once -- share one fetch.
   The map is scoped to that request's ExecutionContext, never the isolate: an
   R2 read belongs to the request that started it, so a promise handed to a
   later request can never settle.  Cloudflare fails that await instead of
   hanging, which surfaced as "catalog unavailable" on the page after a busy
   one.  Only resolved bytes go in `memory`, and those are safe to share. */
const inFlightByRequest = new WeakMap();

function inFlightFor(ctx) {
  if (!ctx || typeof ctx !== "object") return null;
  let map = inFlightByRequest.get(ctx);
  if (!map) {
    map = new Map();
    inFlightByRequest.set(ctx, map);
  }
  return map;
}

async function cachedBytes(env, ctx, key) {
  /* the stamp is captured up front, so a read that began under one upload can
     never be filed under the next one */
  const stamp = dataVersion || "e" + dataEpoch;
  const memKey = stamp + "/" + key;
  if (memory.has(memKey)) return memory.get(memKey);
  const inFlight = inFlightFor(ctx);
  if (inFlight && inFlight.has(memKey)) return inFlight.get(memKey);
  const work = loadBytes(env, ctx, key, stamp).finally(() => {
    if (inFlight) inFlight.delete(memKey);
  });
  if (inFlight) inFlight.set(memKey, work);
  return work;
}

async function loadBytes(env, ctx, key, stamp) {
  const memKey = stamp + "/" + key;
  const cache = caches.default;
  const cacheKey = new Request("https://shelf.internal/" + stamp + "/" + key);
  const maxAge = Math.round((dataVersion ? CACHE_TTL_MS : DATA_TTL_MS) / 1000);
  try {
    const hit = await cache.match(cacheKey);
    if (hit) {
      const bytes = new Uint8Array(await hit.arrayBuffer());
      memory.set(memKey, bytes);
      return bytes;
    }
  } catch (err) {
    /* cache unavailable: go to R2 */
  }
  const bytes = await objectBytes(env, key);
  memory.set(memKey, bytes);
  try {
    ctx.waitUntil(
      cache.put(cacheKey, new Response(bytes, { headers: { "Cache-Control": "public, max-age=" + maxAge } }))
    );
  } catch (err) {
    /* ignore */
  }
  return bytes;
}

function parseIndex(buffer) {
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== MAGIC) throw new Error("bad shelf index");
  const version = view.getUint32(4, true);
  if (version !== 1) throw new Error("unsupported shelf index version " + version);
  const count = view.getUint32(8, true);
  const size = view.getUint32(12, true);
  const lowerUnits = view.getUint32(16, true);
  const offsets = new Uint32Array(buffer, 20, count + 1);
  const titleAt = new Uint32Array(buffer, 20 + (count + 1) * 4, count);
  return { count, size, lowerUnits, offsets, titleAt };
}

/**
 * A shelf's row index, which every request needs and nothing else costs.
 *
 * The lowercased-title blob is deliberately NOT here: it is 7 MB on the
 * mangaupdates shelf and only a search scans it, so a sorted page or a title
 * page used to pay for it on the first request of every isolate.  That was the
 * half-second before a shelf appeared.
 */
async function loadShell(env, ctx, spec) {
  const key = "shell:" + spec.name;
  if (memory.has(key)) return memory.get(key);
  const indexBuf = await cachedBytes(env, ctx, spec.name + "/index.bin");
  const shell = { spec, index: parseIndex(indexBuf.buffer.slice(0)), ids: null, lower: null };
  memory.set(key, shell);
  return shell;
}

async function ensureLower(env, ctx, shelf) {
  if (shelf.lower) return shelf.lower;
  shelf.lower = text(await cachedBytes(env, ctx, shelf.spec.name + "/lower.txt"));
  return shelf.lower;
}

function parseIds(idsBuf, idsIdxBuf) {
  const idsView = new DataView(idsIdxBuf.buffer, idsIdxBuf.byteOffset, idsIdxBuf.byteLength);
  const n = idsView.getUint32(0, true);
  const at = new Uint32Array(idsIdxBuf.buffer, idsIdxBuf.byteOffset + 4, n);
  const row = new Uint32Array(idsIdxBuf.buffer, idsIdxBuf.byteOffset + 4 + n * 4, n);
  return { blob: idsBuf, at, row, count: n };
}

/**
 * The id index of a shelf that only needs it for title pages.  Fetching it up
 * front for the mangaupdates shelf would add megabytes to the first API page of
 * the session without being used.
 */
async function ensureIds(env, ctx, shelf) {
  if (shelf.ids) return shelf.ids;
  const name = shelf.spec.name;
  const [idsBuf, idsIdxBuf] = await Promise.all([
    cachedBytes(env, ctx, name + "/ids.bin"),
    cachedBytes(env, ctx, name + "/ids.idx"),
  ]);
  shelf.ids = parseIds(idsBuf, idsIdxBuf);
  return shelf.ids;
}

/**
 * A shelf's per-row extras: the long synopsis, its tags, the update date.
 *
 * Only the offset table is held in memory (1 MB for 245k rows); the record
 * itself is a ranged GET.  Pulling the whole file in — 88 MB for mangaupdates —
 * would put a Worker's 128 MB isolate limit within reach, and one title page
 * only ever needs its own 500 bytes.
 */
async function loadMetaIndex(env, ctx, spec) {
  const key = "metaidx:" + spec.name;
  if (memory.has(key)) return memory.get(key);
  let index = null;
  try {
    const head = await env.BUCKET.get(spec.name + "/meta.bin", { range: { offset: 0, length: 16 } });
    if (head) {
      const headBytes = new Uint8Array(await head.arrayBuffer());
      if (headBytes.byteLength === 16 &&
          String.fromCharCode(headBytes[0], headBytes[1], headBytes[2], headBytes[3]) === "MKMT") {
        const count = new DataView(headBytes.buffer, headBytes.byteOffset, 16).getUint32(8, true);
        const tableLength = (count + 1) * 4;
        const table = await env.BUCKET.get(spec.name + "/meta.bin", {
          range: { offset: 16, length: tableLength },
        });
        if (table) {
          const tableBytes = new Uint8Array(await table.arrayBuffer());
          index = {
            count,
            start: 16 + tableLength,
            at: new Uint32Array(tableBytes.buffer, tableBytes.byteOffset, count + 1),
          };
        }
      }
    }
  } catch (err) {
    index = null;
  }
  memory.set(key, index);
  return index;
}

async function metaFor(env, ctx, spec, row) {
  const index = await loadMetaIndex(env, ctx, spec);
  if (!index || row < 0 || row >= index.count) return null;
  const from = index.start + index.at[row];
  const to = index.start + index.at[row + 1];
  if (to <= from) return null;
  try {
    const obj = await env.BUCKET.get(spec.name + "/meta.bin", { range: { offset: from, length: to - from } });
    if (!obj) return null;
    return JSON.parse(text(new Uint8Array(await obj.arrayBuffer())));
  } catch (err) {
    return null;
  }
}

/** genre -> the rows carrying it, for "more like this". */
async function loadGenres(env, ctx, spec) {
  const key = "genres:" + spec.name;
  if (memory.has(key)) return memory.get(key);
  let bytes = null;
  try {
    bytes = await cachedBytes(env, ctx, spec.name + "/genres.bin");
  } catch (err) {
    bytes = null;
  }
  let index = null;
  if (bytes && bytes.byteLength > 20 && String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) === "MKGN") {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const n = view.getUint32(8, true);
    const namesLen = view.getUint32(12, true);
    const rowsTotal = view.getUint32(16, true);
    const base = 20;
    const nameAt = new Uint32Array(bytes.buffer, bytes.byteOffset + base, n);
    const nameLen = new Uint32Array(bytes.buffer, bytes.byteOffset + base + n * 4, n);
    const rowAt = new Uint32Array(bytes.buffer, bytes.byteOffset + base + n * 8, n);
    const rowCnt = new Uint32Array(bytes.buffer, bytes.byteOffset + base + n * 12, n);
    const namesStart = base + n * 16;
    const rows = new Uint32Array(bytes.buffer, bytes.byteOffset + namesStart + namesLen, rowsTotal);
    const byName = new Map();
    for (let i = 0; i < n; i++) {
      byName.set(text(bytes.subarray(namesStart + nameAt[i], namesStart + nameAt[i] + nameLen[i])), i);
    }
    index = { byName, rowAt, rowCnt, rows };
  }
  memory.set(key, index);
  return index;
}

/**
 * A prepared ordering: row indices plus the year of each row, so "newest" and
 * "highest rated" are a slice of an array instead of a 245k-row sort per
 * request.  Built offline by cloud/build_data.py.
 */
async function loadOrder(env, ctx, spec, kind) {
  const key = "order:" + spec.name + ":" + kind;
  if (memory.has(key)) return memory.get(key);
  const bytes = await cachedBytes(env, ctx, spec.name + "/order-" + kind + ".bin");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== "MKOR") {
    throw new Error("bad order file " + kind);
  }
  const version = view.getUint32(4, true);
  const count = view.getUint32(8, true);
  const rows = new Uint32Array(bytes.buffer, bytes.byteOffset + 16, count);
  const years = new Uint32Array(bytes.buffer, bytes.byteOffset + 16 + count * 4, count);
  /* version 2 appends a score, on the shelf's own scale x10; version 1 files
     (from before a merged feed existed) simply have none */
  const scores = version >= 2
    ? new Uint16Array(bytes.buffer, bytes.byteOffset + 16 + count * 8, count)
    : null;
  const order = { rows, years, scores, count };
  memory.set(key, order);
  return order;
}

/** The mgeko feed's own ordering, scored on the same 0-100 scale as the others
 *  (its ratings are out of 5, so x20 puts it next to mangaupdates' x10). */
function catalogOrder(rows, kind) {
  const key = "catalog:order:" + kind;
  if (memory.has(key)) return memory.get(key);
  const picks = [];
  for (let i = 0; i < rows.length; i++) {
    if (kind === "read") {
      const views = Number(rows[i][5]) || 0;
      if (views > 0) picks.push([i, views]);
    } else {
      const rating = parseFloat(rows[i][4]);
      if (rating > 0) picks.push([i, Math.round(rating * 20)]);
    }
  }
  picks.sort((a, b) => (b[1] - a[1]) || (a[0] - b[0]));
  const list = {
    rows: new Uint32Array(picks.length),
    /* only two streams can need a cross-shelf score, and neither of these
       single-stream lanes does; kept for the shape the merge loop expects */
    scores: new Uint16Array(picks.length),
    years: new Uint32Array(picks.length),
    count: picks.length,
  };
  picks.forEach(([row], at) => { list.rows[at] = row; });
  memory.set(key, list);
  return list;
}

async function loadCatalog(env, ctx) {
  if (memory.has("catalog")) return memory.get("catalog");
  const bytes = await cachedBytes(env, ctx, "catalog/rows.json");
  const rows = JSON.parse(text(bytes));
  memory.set("catalog", rows);
  return rows;
}

/* ---------- search ---------- */

/** Index of the last offset <= value, i.e. bisect_right(offsets, value) - 1. */
function rowForOffset(titleAt, at) {
  let lo = 0;
  let hi = titleAt.length - 1;
  let answer = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (titleAt[mid] <= at) {
      answer = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return answer;
}

/**
 * Matching rows, ranked exactly as serve.py ranks them: titles that begin with
 * the query first, then titles beginning with any query word, then the rest in
 * file order.
 */
function searchShelf(lower, index, words) {
  let hits = null;
  for (const word of words) {
    const found = new Set();
    let at = lower.indexOf(word);
    while (at !== -1) {
      found.add(rowForOffset(index.titleAt, at));
      at = lower.indexOf(word, at + 1);
    }
    if (hits === null) hits = found;
    else {
      for (const row of hits) if (!found.has(row)) hits.delete(row);
    }
    if (!hits.size) return [];
  }
  const first = words[0];
  const ranked = [];
  for (const row of hits) {
    const start = index.titleAt[row];
    const stop = lower.indexOf("\n", start);
    const lowerTitle = lower.slice(start, stop === -1 ? lower.length : stop);
    let rank = 0;
    if (lowerTitle.startsWith(first)) rank = 2;
    else if (words.some((word) => lowerTitle.startsWith(word))) rank = 1;
    ranked.push([-rank, row]);
  }
  ranked.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
  return ranked.map((pair) => pair[1]);
}

function searchCatalog(rows, words) {
  const first = words[0];
  const ranked = [];
  for (let index = 0; index < rows.length; index++) {
    const lowerTitle = rows[index][1].toLowerCase();
    if (!words.every((word) => lowerTitle.includes(word))) continue;
    let rank = 0;
    if (lowerTitle.startsWith(first)) rank = 2;
    else if (words.some((word) => lowerTitle.startsWith(word))) rank = 1;
    ranked.push([-rank, index]);
  }
  ranked.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
  return ranked.map((pair) => pair[1]);
}

/* ---------- rows ---------- */

/**
 * Read the requested rows out of the TSV in as few ranged GETs as possible.
 *
 * An unsearched page is a contiguous block of the file, so it is one GET.
 * Search results are scattered, and each run of adjacent rows becomes one GET.
 */
async function readRows(env, spec, index, rows) {
  if (!rows.length) return [];
  const ranges = [];
  let start = rows[0];
  let last = rows[0];
  for (let i = 1; i < rows.length; i++) {
    if (rows[i] === last + 1) {
      last = rows[i];
      continue;
    }
    ranges.push([start, last]);
    start = last = rows[i];
  }
  ranges.push([start, last]);

  const payloads = await Promise.all(
    ranges.map(async ([from, to]) => {
      const begin = index.offsets[from];
      const end = index.offsets[to + 1];
      const obj = await env.BUCKET.get(spec.name + "/rows.bin", {
        range: { offset: begin, length: end - begin },
      });
      if (!obj) throw new Error("missing rows for " + spec.name);
      const bytes = new Uint8Array(await obj.arrayBuffer());
      const out = [];
      let cursor = 0;
      for (let i = from; i <= to; i++) {
        const length = index.offsets[i + 1] - index.offsets[i];
        let slice = bytes.subarray(cursor, cursor + length);
        cursor += length;
        if (slice.length && slice[slice.length - 1] === 10) slice = slice.subarray(0, slice.length - 1);
        out.push(slice);
      }
      return out;
    })
  );
  return payloads.flat();
}

function fieldsOf(rowBytes) {
  const decoder = new TextDecoder("utf-8");
  const out = [];
  let start = 0;
  for (let i = 0; i <= rowBytes.length; i++) {
    if (i === rowBytes.length || rowBytes[i] === 9) {
      out.push(decoder.decode(rowBytes.subarray(start, i)));
      start = i + 1;
    }
  }
  return out;
}

function itemFor(spec, parts) {
  const slug = parts[0];
  if (spec.name === "library") {
    /* the harvest rows carry a fourth field: their own source page.  Their
       cover is already the URL the browser should load -- a /img/kun/ path the
       Worker proxies, or a bato1 CDN address that hotlinks -- so neither is
       re-pointed at mangagg.  Three-field rows are unchanged. */
    if (parts.length > 3) {
      const source = parts[4] ||
        (String(parts[2] || "").indexOf("/img/kun/") === 0 ? "kun" : "bato");
      return {
        slug,
        title: parts[1],
        url: parts[3] || "",
        cover: parts[2] || "",
        read: "/reader/harvest/" + source + "/" + pyQuote(slug),
      };
    }
    return {
      slug,
      title: parts[1],
      url: spec.base + pyQuote(slug),
      cover: parts[2] ? "/api/cover/" + pyQuote(slug) : "",
    };
  }
  if (spec.name === "mangadex") {
    return {
      slug,
      title: parts[1],
      url: spec.base + pyQuote(slug),
      cover: parts[2] ? "/api/dexcover/" + pyQuote(slug) : "",
      badge: parts[3] || "",
      year: parts[4] || "",
      teaser: parts[5] || "",
    };
  }
  return {
    slug,
    title: parts[1],
    url: parts[2] || "",
    cover: parts[3] || "",
    badge: parts[4] || "",
    year: parts[5] || "",
    rating: parts[6] || "",
    teaser: parts[7] || "",
  };
}

/* serve.py's teaser drops the trailing word even when the synopsis already
   fits, so a short synopsis loses its last word too.  Matching it exactly is
   the difference between 240 identical responses and a page of drift. */
function teaserOf(synopsis) {
  const text = synopsis || "";
  const cut = text.slice(0, SYNOPSIS_PREVIEW);
  const space = cut.lastIndexOf(" ");
  return (space > 0 ? cut.slice(0, space) : cut) + (text.length > SYNOPSIS_PREVIEW ? "\u2026" : "");
}

/* ---------- paging ---------- */

async function pageShelf(env, ctx, spec, query, offset, limit, sort, minYear) {
  const words = normalize(query).split(" ").filter(Boolean);
  const sorted = !words.length && sort && spec.sorts.includes(sort);
  /* the row index and the ordering file are independent reads; asking for them
     one after the other was a full extra round trip on every cold page */
  const [shelf, order] = await Promise.all([
    loadShell(env, ctx, spec),
    sorted ? loadOrder(env, ctx, spec, sort) : null,
  ]);
  let window;
  let total;

  if (words.length) {
    /* a search is a relevance list: it ignores the sort control */
    const lower = await ensureLower(env, ctx, shelf);
    const hits = searchShelf(lower, shelf.index, words);
    total = hits.length;
    window = hits.slice(offset, offset + limit);
  } else if (order) {
    window = [];
    total = 0;
    /* one pass: count every match, keep the slice.  Undated rows are absent
       from the "new" ordering rather than sorted to the bottom. */
    for (let i = 0; i < order.count; i++) {
      if (minYear && order.years[i] < minYear) continue;
      if (total >= offset && window.length < limit) window.push(order.rows[i]);
      total += 1;
    }
  } else {
    total = shelf.index.count;
    const count = Math.max(0, Math.min(limit, total - offset));
    window = Array.from({ length: count }, (_, i) => offset + i);
  }

  const payloads = await readRows(env, spec, shelf.index, window);
  return { total, items: payloads.map((bytes) => itemFor(spec, fieldsOf(bytes))) };
}

/* The row shape catalog/rows.json carries: 0-8 as before, then the nightly
   chapter bake appended by chapter_scraper.py, then the catalogue's first-seen
   stamp.  A row from an older rows.json simply has zeros, and the card falls
   back to /api/info as it used to. */
function catalogRowItem(row) {
  return {
    slug: row[0],
    title: row[1],
    url: row[2] || MGEKO_BASE + row[0] + "/",
    cover: row[3] || "",
    rating: row[4],
    views: row[5] || 0,
    teaser: teaserOf(row[6] || ""),
    description: row[6] || "",
    genres: row[7] || [],
    badge: row[8] || "",
    chapters: Number(row[9]) || 0,
    status: row[10] || "",
    updatedAt: Number(row[11]) || 0,
    infoFetched: Number(row[12]) || 0,
    firstSeen: Number(row[13]) || 0,
    /* harvested rows carry the in-site reader address here; mgeko rows do not */
    read: row[14] || "",
  };
}

async function pageCatalog(env, ctx, query, offset, limit) {
  const rows = await loadCatalog(env, ctx);
  const words = normalize(query).split(" ").filter(Boolean);
  /* searchCatalog returns row indices; the page needs the rows themselves */
  const picked = words.length ? searchCatalog(rows, words).map((i) => rows[i]) : null;
  const total = picked ? picked.length : rows.length;
  const window = (picked || rows).slice(offset, offset + limit);
  return { total, items: window.map(catalogRowItem) };
}

/* ---------- recently updated ----------
   Every catalogue row now says when its last chapter landed, and every title
   says when the catalogue first listed it.  The shelf is the union: a chapter in
   the past week, or a series that is itself new.  Without the second half a
   title added yesterday could sit invisible until its first chapter was baked.
   A week is short enough to be a real feed and long enough that a quiet day is
   not empty. */
const FRESH_DAYS = 7;
const FRESH_CACHE_MS = 3600000;
/* mangagg has no dates behind its covers, only the date its latest chapter went
   up, and its archive is ordered by that.  The poll (build_mangagg_updates.py)
   writes the head; this caps how many of those rows join the feed. */
const LIBRARY_FRESH_CAP = 60;

function freshStamp(row) {
  return Math.max(Number(row[11]) || 0, Number(row[13]) || 0);
}

async function freshCatalog(env, ctx) {
  const cached = memory.get("catalog:fresh");
  if (cached && Date.now() - cached.at < FRESH_CACHE_MS) return cached.rows;
  const rows = await loadCatalog(env, ctx);
  const cutoff = Math.floor(Date.now() / 1000) - FRESH_DAYS * 86400;
  const fresh = rows.filter((row) => freshStamp(row) >= cutoff);
  fresh.sort((a, b) => (freshStamp(b) - freshStamp(a)) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  memory.set("catalog:fresh", { at: Date.now(), rows: fresh });
  return fresh;
}

/* The mangagg half of the feed, packed from the poll's head.  Reading it is one
   small R2 object, cached like the catalogue's own file for an hour. */
async function libraryFresh(env, ctx) {
  const cached = memory.get("library:fresh");
  if (cached && Date.now() - cached.at < FRESH_CACHE_MS) return cached.rows;
  let rows = [];
  try {
    const bytes = await cachedBytes(env, ctx, "library/fresh.json");
    const parsed = JSON.parse(text(bytes));
    if (Array.isArray(parsed)) rows = parsed;
  } catch (err) {
    rows = [];
  }
  memory.set("library:fresh", { at: Date.now(), rows });
  return rows;
}

/* One mangagg row as the same feed item a mgeko row produces.  page "series" is
   what the app's story page and card links key off, and source keeps a star in
   the mangagg bucket; neither is printed on the card. */
function libraryFreshItem(rec) {
  const slug = String(rec.s || "");
  if (!slug) return null;
  return {
    slug,
    title: String(rec.n || slug),
    url: SHELVES.series.base + pyQuote(slug),
    cover: rec.v ? "/api/cover/" + pyQuote(slug) : "",
    chapters: Number(rec.c) || 0,
    updatedAt: Number(rec.t) || 0,
    page: "series",
    source: "mangagg",
  };
}

function feedStamp(item) {
  return Math.max(Number(item.updatedAt) || 0, Number(item.firstSeen) || 0);
}

async function handleFresh(env, ctx, url) {
  const offset = Math.max(0, parseInt_(url.searchParams.get("offset"), 0));
  const limit = Math.min(200, Math.max(1, parseInt_(url.searchParams.get("limit"), 48)));
  const query = url.searchParams.get("q") || "";
  const started = Date.now();
  try {
    const [rows, library] = await Promise.all([
      freshCatalog(env, ctx),
      libraryFresh(env, ctx),
    ]);
    const cutoff = Math.floor(Date.now() / 1000) - FRESH_DAYS * 86400;
    const words = normalize(query).split(" ").filter(Boolean);
    /* mgeko keeps its relevance order for a search; mangagg has no order to
       preserve beyond the date, so both halves are filtered by title */
    const catalog = (words.length ? searchCatalog(rows, words).map((i) => rows[i]) : rows)
      .map(catalogRowItem);
    const latest = library
      .filter((rec) => (Number(rec.t) || 0) >= cutoff)
      .slice(0, LIBRARY_FRESH_CAP)
      .map(libraryFreshItem)
      .filter(Boolean);

    let items = catalog.concat(latest);
    items.sort((a, b) => (feedStamp(b) - feedStamp(a)) ||
      (String(a.title).toLowerCase() < String(b.title).toLowerCase() ? -1 : 1) ||
      (a.slug < b.slug ? -1 : 1));

    /* one story indexed by both catalogues should not be two rows in a feed
       that does not say which is which; the newer copy is the one kept */
    const seen = new Set();
    const merged = [];
    for (const item of items) {
      const key = normalize(item.title);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
    }
    const picked = words.length
      ? merged.filter((item) => words.every((word) => String(item.title).toLowerCase().includes(word)))
      : merged;

    return json(200, {
      total: picked.length,
      offset,
      limit,
      freshDays: FRESH_DAYS,
      items: picked.slice(offset, offset + limit),
      elapsed_ms: Date.now() - started,
    });
  } catch (err) {
    return json(500, { error: "fresh shelf unavailable: " + err.message });
  }
}

/* ---------- the merged feed ----------
   "Newest" used to mean "newest on mangaupdates", because that was the only
   shelf the discover page asked.  Two of the four catalogues publish a year
   (mangadex 76% of rows, mangaupdates 97%), and two publish a rating (mangaupdates
   out of 10, mgeko out of 5 — the mangagg library publishes neither), so the
   merged feed is newest = mangadex + mangaupdates, top rated = mangaupdates +
   mgeko.  Each stream is already ordered; a two-way merge walks them together.
   The tie-breaks are integers only (year, row, stream) so that serve.py, which
   does the same merge in Python, lands on the same page.

   Known limitation: the same series indexed by both mangaupdates and mangadex
   appears twice.  Deduping would have to be global (a shared title hash across
   the whole catalogue), not per page, or page boundaries would shift. */

const MERGED_STREAMS = {
  /* the two catalogues that publish a publication year */
  new: [
    { name: "mangadex", page: "mangadex", spec: "mangadex", kind: "new" },
    { name: "mangaupdates", page: "mangaupdates", spec: "mangaupdates", kind: "new" },
  ],
  /* only mangaupdates rates out of ten with a vote count behind it.  mgeko's
     ratings are out of five and 500 of its 7,064 titles sit at a perfect 5.0, so
     scoring them into the same list would put a page of noise above every 9.2 */
  best: [
    { name: "mangaupdates", page: "mangaupdates", spec: "mangaupdates", kind: "best" },
  ],
  /* what mgeko does publish is readership, and nobody else does */
  read: [
    { name: "mgeko", page: "catalog", spec: "catalog", kind: "read" },
  ],
};

function catalogItem(row) {
  return {
    slug: row[0],
    title: row[1],
    url: row[2] || MGEKO_BASE + row[0] + "/",
    cover: row[3] || "",
    badge: row[8] || "",
    rating: row[4],
    views: row[5] || 0,
    teaser: teaserOf(row[6] || ""),
    chapters: Number(row[9]) || 0,
    status: row[10] || "",
    updatedAt: Number(row[11]) || 0,
    infoFetched: Number(row[12]) || 0,
  };
}

async function mergedStreams(env, ctx, sort) {
  return Promise.all(MERGED_STREAMS[sort].map(async (entry, index) => {
    if (entry.spec === "catalog") {
      const rows = await loadCatalog(env, ctx);
      const order = catalogOrder(rows, entry.kind);
      return { index, entry, order, count: order.count, catalog: rows };
    }
    const order = await loadOrder(env, ctx, SHELVES[entry.spec], entry.kind);
    return { index, entry, order, count: order.count, catalog: null };
  }));
}

function mergedItem(stream, item) {
  const out = Object.assign({}, item, { source: stream.entry.name, page: stream.entry.page });
  if (stream.entry.name === "mgeko") out.ratingScale = 5;
  else if (stream.entry.name === "mangaupdates") out.ratingScale = 10;
  return out;
}

async function mergedPage(env, ctx, sort, offset, limit, minYear) {
  const streams = await mergedStreams(env, ctx, sort);
  const cursor = streams.map(() => 0);
  const picked = [];
  let total = 0;

  const comesFirst = (a, ai, b, bi) => {
    if (sort === "best" && a.order.scores && b.order.scores) {
      if (a.order.scores[ai] !== b.order.scores[bi]) return a.order.scores[ai] > b.order.scores[bi];
    }
    if (a.order.years[ai] !== b.order.years[bi]) return a.order.years[ai] > b.order.years[bi];
    if (a.order.rows[ai] !== b.order.rows[bi]) return a.order.rows[ai] < b.order.rows[bi];
    return a.index < b.index;
  };

  for (;;) {
    let pick = -1;
    for (let s = 0; s < streams.length; s++) {
      if (cursor[s] >= streams[s].count) continue;
      if (pick === -1 || comesFirst(streams[s], cursor[s], streams[pick], cursor[pick])) pick = s;
    }
    if (pick === -1) break;

    if (sort === "new" && minYear) {
      /* both streams run newest-first: once neither has a row this recent,
         there is nothing left to count */
      let anyRecent = false;
      for (let s = 0; s < streams.length; s++) {
        if (cursor[s] < streams[s].count && streams[s].order.years[cursor[s]] >= minYear) {
          anyRecent = true;
          break;
        }
      }
      if (!anyRecent) break;
    }

    const stream = streams[pick];
    const at = cursor[pick]++;
    const year = stream.order.years[at];
    if (minYear && year < minYear) continue;
    if (total >= offset && picked.length < limit) picked.push({ stream, row: stream.order.rows[at] });
    total += 1;
  }

  /* one ranged read per stream, then put the rows back in merged order */
  const grouped = new Map();
  for (const entry of picked) {
    const list = grouped.get(entry.stream) || [];
    list.push(entry);
    grouped.set(entry.stream, list);
  }

  const built = new Map();
  await Promise.all([...grouped.entries()].map(async ([stream, entries]) => {
    if (stream.catalog) {
      for (const entry of entries) {
        built.set(stream.index + ":" + entry.row, catalogItem(stream.catalog[entry.row]));
      }
      return;
    }
    const spec = SHELVES[stream.entry.spec];
    const shell = await loadShell(env, ctx, spec);
    const payloads = await readRows(env, spec, shell.index, entries.map((entry) => entry.row));
    payloads.forEach((bytes, i) => {
      built.set(stream.index + ":" + entries[i].row, itemFor(spec, fieldsOf(bytes)));
    });
  }));

  return {
    total,
    items: picked.map((entry) => mergedItem(entry.stream, built.get(entry.stream.index + ":" + entry.row))),
  };
}

const MERGED_CACHE_SECONDS = 30;

async function handleMerged(env, ctx, url) {
  const wanted = url.searchParams.get("sort") || "new";
  const sort = Object.prototype.hasOwnProperty.call(MERGED_STREAMS, wanted) ? wanted : "new";
  const offset = Math.max(0, parseInt_(url.searchParams.get("offset"), 0));
  const limit = Math.min(200, Math.max(1, parseInt_(url.searchParams.get("limit"), 48)));
  const minYear = Math.max(0, parseInt_(url.searchParams.get("minYear"), 0));
  const started = Date.now();

  const cache = caches.default;
  const cacheKey = new Request("https://pages.internal/all?s=" + sort + "&o=" + offset + "&n=" + limit + "&y=" + minYear);
  try {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  } catch (err) {
    /* no cache: build it */
  }

  try {
    const result = await mergedPage(env, ctx, sort, offset, limit, minYear);
    const payload = { total: result.total, offset, limit, sort, items: result.items };
    const body = JSON.stringify(payload);
    const headers = {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=" + MERGED_CACHE_SECONDS,
      "X-Robots-Tag": "noindex, nofollow",
    };
    ctx.waitUntil(cache.put(cacheKey, new Response(body, { headers })));
    return new Response(
      JSON.stringify(Object.assign({}, payload, { elapsed_ms: Date.now() - started })),
      { headers: Object.assign({}, headers, { "Cache-Control": "no-store" }) }
    );
  } catch (err) {
    return json(500, { error: "merged feed unavailable: " + err.message });
  }
}

/* ---------- covers ---------- */

async function lookupIdent(env, ctx, spec, ident) {
  const shelf = await loadShell(env, ctx, spec);
  const ids = await ensureIds(env, ctx, shelf);
  const encoder = new TextEncoder();
  const key = encoder.encode(ident);
  const { blob, at, row, count } = ids;
  let lo = 0;
  let hi = count - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const start = at[mid];
    let end = start;
    while (end < blob.length && blob[end] !== 10) end++;
    const current = blob.subarray(start, end);
    if (current.length === key.length && current.every((b, i) => b === key[i])) return row[mid];
    let cmp = 0;
    const shortest = Math.min(current.length, key.length);
    for (let i = 0; i < shortest; i++) {
      if (current[i] !== key[i]) {
        cmp = current[i] < key[i] ? -1 : 1;
        break;
      }
    }
    if (!cmp) cmp = current.length === key.length ? 0 : current.length < key.length ? -1 : 1;
    if (cmp === 0) return row[mid];
    if (cmp < 0) lo = mid + 1;
    else hi = mid - 1;
  }
  return null;
}

async function coverUrlFor(env, ctx, spec, ident) {
  const row = await lookupIdent(env, ctx, spec, ident);
  if (row === null || row === undefined) return null;
  const shelf = await loadShell(env, ctx, spec);
  const payloads = await readRows(env, spec, shelf.index, [row]);
  const parts = fieldsOf(payloads[0]);
  return parts[2] || null;
}

async function cachedCover(env, ctx, key, url, headers, variants) {
  const cache = caches.default;
  const cacheKey = new Request("https://covers.internal/" + key);
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  for (const variant of variants) {
    let response;
    try {
      response = await fetch(url + variant, { headers });
    } catch (err) {
      continue;
    }
    if (response.status === 429) continue;
    if (response.status === 200) {
      const type = response.headers.get("Content-Type") || "";
      if (!type.startsWith("image")) continue;
      const body = await response.arrayBuffer();
      const out = new Response(body, {
        headers: {
          "Content-Type": type.split(";")[0],
          "Content-Length": String(body.byteLength),
          "Cache-Control": "public, max-age=604800",
          "X-Robots-Tag": "noindex, nofollow",
        },
      });
      ctx.waitUntil(cache.put(cacheKey, out.clone()));
      return out;
    }
    if (response.status !== 404) continue;
  }
  return null;
}

/* ---------- chapter images ---------- */

function imageFromObject(obj) {
  const meta = obj.httpMetadata || {};
  const headers = {
    "Content-Type": meta.contentType || "image/webp",
    "Cache-Control": "public, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff",
    "Access-Control-Allow-Origin": "*",
  };
  if (obj.size != null) headers["Content-Length"] = String(obj.size);
  return new Response(obj.body, { headers });
}

function imageMiss(status, maxAge) {
  return new Response("", {
    status: status,
    headers: {
      "Cache-Control": maxAge ? "public, max-age=" + maxAge : "no-store",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

/**
 * One page, R2 first, then the CDN.
 *
 * The R2 key is a SHA-256 of the upstream URL, so the same page requested by
 * a hundred readers is one object, and the key is a legal R2 name whatever the
 * source path looks like.  Images never change under a URL, so both layers are
 * immutable; a miss that reaches the CDN is stored for the next reader.
 */
async function imageProxyResponse(env, ctx, url) {
  const rest = url.pathname.slice("/img/".length);
  const cut = rest.indexOf("/");
  const target = cut > 0 ? imageProxyTarget(rest.slice(0, cut), rest.slice(cut + 1)) : null;
  if (!target) return imageMiss(404, 0);

  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(target.url));
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  const objectKey = "img/" + target.source + "/" + hex;
  const cacheKey = new Request("https://img.internal/" + target.source + "/" + hex);
  const cache = caches.default;
  const later = (work) => {
    try {
      if (ctx && ctx.waitUntil) ctx.waitUntil(Promise.resolve(work).catch(() => {}));
    } catch (err) {
      /* no execution context in a test harness */
    }
  };

  try {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  } catch (err) {
    /* cache unavailable: R2 is next */
  }

  try {
    const stored = await env.BUCKET.get(objectKey);
    if (stored) {
      const out = imageFromObject(stored);
      later(cache.put(cacheKey, out.clone()));
      return out;
    }
  } catch (err) {
    /* fall through to the CDN */
  }

  let upstream;
  try {
    upstream = await fetch(target.url, {
      headers: Object.assign({ Referer: target.referer }, IMAGE_HEADERS),
    });
  } catch (err) {
    return imageMiss(502, 30);
  }
  if (upstream.status !== 200) {
    /* a 403 here means the CDN changed its referer rule; a 404 is a dead page.
       Short-cache both so a hot loop cannot hammer the CDN. */
    return imageMiss(upstream.status === 404 ? 404 : 502, 30);
  }
  const type = (upstream.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
  if (!type.startsWith("image/")) return imageMiss(502, 30);
  const declared = parseInt_(upstream.headers.get("Content-Length"), 0);
  if (declared > IMAGE_MAX_BYTES) return imageMiss(413, 0);
  const body = await upstream.arrayBuffer();
  if (body.byteLength > IMAGE_MAX_BYTES) return imageMiss(413, 0);

  const out = new Response(body, {
    headers: {
      "Content-Type": type,
      "Content-Length": String(body.byteLength),
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      "Access-Control-Allow-Origin": "*",
    },
  });
  later(env.BUCKET.put(objectKey, body, {
    httpMetadata: { contentType: type, cacheControl: "public, max-age=31536000, immutable" },
    customMetadata: { src: target.url.slice(0, 900) },
  }));
  later(cache.put(cacheKey, out.clone()));
  return out;
}

/* ---------- how alive a title is ----------
   A shelf full of finished stories reads as busy because a card says nothing
   about either.  The series page's header carries all three answers -- a chapter
   count, a status word and "Last Update" as a relative phrase -- so one fetch
   fills a card line and the sheet.  Kept under its own tag so a preview and an
   info lookup can miss and refresh independently; six hours is short enough that
   a weekly series shows its new chapter the same day, long enough that browsing
   a shelf costs one series page per title per six hours. */
const INFO_TAG = "2026-11-08a";

function plainText(raw) {
  return String(raw || "").replace(/<[^>]*>/g, " ").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function parseSeriesMeta(html) {
  const header = /<div class="header-stats">([\s\S]*?)<\/div>/.exec(html);
  const head = header ? header[1] : html;

  const chapters = /<strong[^>]*>(?:\s*<i[^>]*>[\s\S]*?<\/i>)?\s*([\d.,]+)[^<]*<\/strong>\s*<small>\s*Chapters?/i.exec(head);
  const status = /<strong[^>]*>\s*([^<]+?)\s*<\/strong>\s*<small>\s*Status/i.exec(head);
  const updated = /<div class="updinfo">\s*<span>\s*Last Update\s*<\/span>\s*<strong>\s*([^<]+?)\s*<\/strong>/i.exec(html);

  /* the chapter list is newest-first, but a header count is the number the
     series page itself shows, so it wins; the list only fills a gap */
  let latest = 0;
  const chaptersRe = /-chapter-([0-9]+(?:\.[0-9]+)?)-/g;
  let m;
  while ((m = chaptersRe.exec(html))) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > latest) latest = n;
  }

  const stats = /<span class="chapter-stats"[^>]*>\s*([^<]+?)\s*<\/span>/.exec(html);
  const meta = {
    chapters: chapters ? parseInt(chapters[1].replace(/[^\d]/g, ""), 10) || 0 : latest,
    status: status ? plainText(status[1]) : "",
    updated: updated ? plainText(updated[1]) : stats ? plainText(stats[1]) : "",
  };
  if (!meta.chapters && !meta.status && !meta.updated) return null;
  return meta;
}

async function seriesMeta(origin, env, ctx, slug) {
  const cache = caches.default;
  const key = new Request(origin + "/info/" + slug + "?v=" + INFO_TAG);
  try {
    const hit = await cache.match(key);
    if (hit) return hit.json();
  } catch (err) { /* the cache is best effort */ }

  try {
    const res = await fetch(MGEKO_BASE + pyQuote(slug) + "/", {
      headers: READER_HEADERS,
      signal: AbortSignal.timeout(READER_TIMEOUT),
      cf: { cacheTtl: 3600, cacheEverything: true },
    });
    if (!res.ok) return null;
    const meta = parseSeriesMeta(await res.text());
    if (!meta) return null;
    if (ctx && ctx.waitUntil) {
      ctx.waitUntil(cache.put(key, new Response(JSON.stringify(meta), {
        headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=21600" },
      })));
    }
    return meta;
  } catch (err) {
    return null;
  }
}

/** Chapter count, status and last update for one title, for the shelf's cards. */
async function infoResponse(env, ctx, url) {
  let slug = url.pathname.slice("/api/info/".length).replace(/\/+$/, "");
  try {
    slug = decodeURIComponent(slug);
  } catch (err) {
    return json(400, { error: "bad slug" });
  }
  if (!slug || slug.indexOf("/") !== -1 || !SLUG_RE.test(slug)) return json(400, { error: "bad slug" });

  const meta = await seriesMeta(url.origin, env, ctx, slug);
  if (!meta) return json(404, { error: "no info" });
  return new Response(JSON.stringify(meta), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=1800",
      "Access-Control-Allow-Origin": "*",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

/* One title's own catalogue row, for the app's story page.  The merged feed
   carries the counts and a trimmed teaser, but the full synopsis and the tag
   list live only in the row, and one title is one id lookup. */
/* mangagg stores a 175x238 derivative beside the cover it uploaded.  A story
   page wants the large one, and dropping the -WxH suffix is the whole trick --
   the proxy still exists for cards, which do want the small file. */
function largeMangaggCover(url) {
  return String(url || "").replace(/-\d+x\d+(\.(?:jpe?g|png|webp|gif))$/i, "$1");
}

async function storyApiResponse(env, ctx, url) {
  let rest = url.pathname.slice("/api/story/".length).replace(/\/+$/, "");
  let shelf = "catalog";
  if (rest.indexOf("series/") === 0) {
    shelf = "series";
    rest = rest.slice("series/".length);
  }
  let slug = rest;
  try {
    slug = decodeURIComponent(slug);
  } catch (err) {
    return json(400, { error: "bad slug" });
  }
  if (!slug || slug.indexOf("/") !== -1 || !SLUG_RE.test(slug)) return json(400, { error: "bad slug" });
  try {
    if (shelf === "series") {
      /* the same story shape the app already renders for mgeko, filled from
         the mangagg row and its crawled meta instead of the mgeko feed */
      const built = await bookFor(env, ctx, url, "series", slug);
      if (!built) return json(404, { error: "no story" });
      const book = built.book;
      return new Response(JSON.stringify({
        slug,
        title: book.title,
        url: book.sourceUrl,
        cover: largeMangaggCover(book.cover),
        rating: null,
        views: 0,
        teaser: book.description || "",
        description: book.description || "",
        genres: book.tags || [],
        badge: "",
        chapters: 0,
        status: book.status || "",
        year: book.year || "",
        page: "series",
        source: "mangagg",
      }), {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "public, max-age=600",
          "Access-Control-Allow-Origin": "*",
          "X-Robots-Tag": "noindex, nofollow",
        },
      });
    }
    const rows = await loadCatalog(env, ctx);
    const index = catalogSlugIndex(rows).get(slug);
    if (index === undefined) return json(404, { error: "no story" });
    return new Response(JSON.stringify(catalogRowItem(rows[index])), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=600",
        "Access-Control-Allow-Origin": "*",
        "X-Robots-Tag": "noindex, nofollow",
      },
    });
  } catch (err) {
    return json(502, { error: "story unavailable: " + err.message });
  }
}

/* ---------- per-title pages ----------
   Every title gets a real URL so a link unfurls with its cover and a crawler
   that never touches /api/ still reads the synopsis as text.  The page is
   rendered here and cached at the edge; a title page's data is one id lookup,
   one ranged row read, one ranged meta read and one read for its neighbours. */

const PAGE_SHELVES = {
  series: SHELVES.series,
  mangadex: SHELVES.mangadex,
  mangaupdates: SHELVES.mangaupdates,
};
const RELATED_COUNT = 8;

/* Rendered pages sit in the colo cache for a day, so the cache key carries this
   tag: bump it whenever pages.js, the page half of this file, or the R2 data
   changes, and every page is re-rendered on its next request. */
const PAGE_CACHE_TAG = "2026-11-20a";

/* How long a title wears the "new story" badge.  It is computed when the page is
   rendered rather than written into the page, so a title ages out by itself and
   no rebuild has to sweep the catalogue every week. */
const NEW_STORY_DAYS = 7;

/* "2026-10-31" within N days of today, in UTC.  A date from the near future is
   two clocks disagreeing, not a reason to withhold the badge. */
function withinDays(isoDay, days) {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDay || ""));
  if (!parts) return false;
  const age = Date.now() - Date.UTC(+parts[1], +parts[2] - 1, +parts[3]);
  return age > -86400000 && age <= days * 86400000;
}

/** Slug -> row for the mgeko feed, which is already in memory as JSON. */
function catalogSlugIndex(rows) {
  if (memory.has("catalog:slugs")) return memory.get("catalog:slugs");
  const map = new Map();
  for (let i = 0; i < rows.length; i++) map.set(rows[i][0], i);
  memory.set("catalog:slugs", map);
  return map;
}

/** genre -> row indices for the mgeko feed, built once per isolate. */
function catalogGenres(rows) {
  if (memory.has("catalog:genres")) return memory.get("catalog:genres");
  const map = new Map();
  for (let i = 0; i < rows.length; i++) {
    for (const genre of rows[i][7] || []) {
      let list = map.get(genre);
      if (!list) map.set(genre, (list = []));
      list.push(i);
    }
  }
  memory.set("catalog:genres", map);
  return map;
}

function stridePick(list, want, seed) {
  const out = [];
  const length = list.length;
  if (!length) return out;
  const step = Math.max(1, Math.floor(length / (want + 1)));
  let at = (seed * 7 + 3) % length;
  for (let guard = 0; out.length < want && guard < want * 3; guard++) {
    const value = list[at % length];
    if (!out.includes(value)) out.push(value);
    at += step;
  }
  return out;
}

/** The same spread, for a shelf whose rows are only numbers (nothing arrayed). */
function strideNumbers(total, want, seed, skip) {
  const out = [];
  if (!total) return out;
  const step = Math.max(1, Math.floor(total / (want + 2)));
  let at = (seed * 7 + 3) % total;
  for (let guard = 0; out.length < want && guard < want * 3; guard++) {
    if (at !== skip && !out.includes(at)) out.push(at);
    at = (at + step) % total;
  }
  return out;
}

async function bookFor(env, ctx, url, shelfName, ident) {
  const origin = url.origin;

  if (shelfName === "catalog") {
    const rows = await loadCatalog(env, ctx);
    const row = catalogSlugIndex(rows).get(ident);
    if (row === undefined) return null;
    const entry = rows[row];
    return {
      shelf: shelfName,
      row,
      book: {
        ident,
        title: entry[1],
        sourceUrl: entry[2] || MGEKO_BASE + ident + "/",
        cover: entry[3] || "",
        ogImage: entry[3] || "",
        rating: entry[4] || "",
        bestRating: 5,
        views: entry[5] || 0,
        teaser: entry[6] || "",
        description: entry[6] || "",
        tags: entry[7] || [],
        badge: entry[8] || "",
      },
    };
  }

  const spec = PAGE_SHELVES[shelfName];
  if (!spec) return null;
  const row = await lookupIdent(env, ctx, spec, ident);
  if (row === null || row === undefined) return null;
  const shelf = await loadShell(env, ctx, spec);
  /* the row and its extra fields are two unrelated reads, and on a cold isolate
     their round trips are what the reader is waiting for */
  const [rowBytes, metaFields] = await Promise.all([
    readRows(env, spec, shelf.index, [row]).then((rows) => rows[0]),
    metaFor(env, ctx, spec, row),
  ]);
  const parts = fieldsOf(rowBytes);
  const meta = metaFields || {};
  const book = {
    ident,
    title: parts[1] || ident,
    year: parts[4] || "",
    tags: meta.g || [],
    description: meta.d || "",
    status: meta.s || "",
    updated: meta.u || "",
    created: meta.c || "",
    alt: meta.a || [],
    votes: meta.v || 0,
  };

  if (shelfName === "series") {
    book.sourceUrl = spec.base + pyQuote(ident);
    book.cover = parts[2] || "";
    book.ogImage = parts[2] ? origin + "/api/cover/" + encodeURIComponent(ident) : "";
  } else if (shelfName === "mangadex") {
    book.sourceUrl = spec.base + pyQuote(ident);
    book.badge = parts[3] || "";
    book.year = parts[4] || "";
    book.teaser = parts[5] || "";
    /* the upstream host answers a foreign referer with a different picture, so
       the page (and the unfurl) both point at the proxy.  The unfurl asks for
       the 512px variant: link previews want a bigger image than a card does. */
    book.cover = parts[2] ? origin + "/api/dexcover/" + encodeURIComponent(ident) : "";
    book.ogImage = book.cover ? book.cover + "?size=large" : "";
  } else {
    book.sourceUrl = parts[2] || "";
    book.cover = parts[3] || "";
    book.ogImage = parts[3] || "";
    book.badge = parts[4] || "";
    book.year = parts[5] || "";
    book.rating = parts[6] || "";
    book.teaser = parts[7] || "";
  }
  /* only mangadex records when a title was added to the catalogue, so it is the
     only shelf that can call one new; mgeko publishes no date at all, and a
     release year says when a story was written, not when it turned up here */
  if (book.created) book.isNew = withinDays(book.created, NEW_STORY_DAYS);
  return { shelf: shelfName, row, book };
}

/* ---------- one title, on its own ----------
   Grid payloads carry a 320-character teaser each; shipping the full synopsis
   of 300,000 rows inside every page of cards would dwarf the posters.  The
   hover panel and the detail sheet ask for one title's remainder at a time, and
   the answer is cached at the edge for a day -- the second reader in a colo
   pays nothing, and the same route serves every shelf. */
async function aboutResponse(env, ctx, url) {
  const rest = url.pathname.slice("/api/about/".length);
  const cut = rest.indexOf("/");
  const shelfName = cut > 0 ? rest.slice(0, cut) : "";
  let ident = cut > 0 ? rest.slice(cut + 1).replace(/\/+$/, "") : "";
  try {
    ident = decodeURIComponent(ident);
  } catch (err) {
    ident = "";
  }
  const known = shelfName === "catalog" || Object.prototype.hasOwnProperty.call(PAGE_SHELVES, shelfName);
  if (!known || !ident || !SLUG_RE.test(ident)) return json(400, { error: "bad title" });

  const cache = caches.default;
  const key = new Request(url.origin + "/api/about/" + dataEpoch + "/" + shelfName + "/" + encodeURIComponent(ident));
  try {
    const hit = await cache.match(key);
    if (hit) return hit;
  } catch (err) {
    /* no cache: build it */
  }

  let built = null;
  try {
    built = await bookFor(env, ctx, url, shelfName, ident);
  } catch (err) {
    return json(503, { error: "catalogue unavailable" });
  }
  if (!built) return json(404, { error: "not found" });

  const b = built.book;
  const body = JSON.stringify({
    slug: ident,
    shelf: shelfName,
    title: b.title || "",
    description: b.description || b.teaser || "",
    teaser: b.teaser || "",
    tags: b.tags || [],
    alt: b.alt || [],
    year: b.year || "",
    status: b.status || "",
    updated: b.updated || "",
    /* when the catalogue listed the title, and whether that is recent enough to
       wear the badge -- the same two facts the title page renders from */
    created: b.created || "",
    isNew: b.isNew === true,
    rating: b.rating || "",
    bestRating: b.bestRating || 10,
    votes: b.votes || 0,
    views: b.views || 0,
    cover: b.cover || "",
    sourceUrl: b.sourceUrl || "",
  });
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    /* the same window as the bytes it was built from, so a re-upload cannot
       leave a title's synopsis answering from an older catalogue */
    "Cache-Control": "public, max-age=" + Math.round(DATA_TTL_MS / 1000),
    "X-Robots-Tag": "noindex, nofollow",
  };
  ctx.waitUntil(cache.put(key, new Response(body, { headers })));
  return new Response(body, { headers });
}

async function relatedFor(env, ctx, shelfName, row, tags) {
  const tag = (tags || [])[0];

  if (shelfName === "catalog") {
    const rows = await loadCatalog(env, ctx);
    const pool = tag ? catalogGenres(rows).get(tag) : null;
    const picks = pool && pool.length > 2
      ? stridePick(pool, RELATED_COUNT + 2, row).filter((index) => index !== row).slice(0, RELATED_COUNT)
      : strideNumbers(rows.length, RELATED_COUNT, row, row);
    return {
      label: tag ? "More " + tag : "More from this shelf",
      items: picks.map((index) => ({
        ident: rows[index][0],
        title: rows[index][1],
        cover: rows[index][3] || "",
      })),
    };
  }

  const spec = PAGE_SHELVES[shelfName];
  if (!spec) return { label: "", items: [] };
  const shelf = await loadShell(env, ctx, spec);
  let picks = null;
  const genres = tag ? await loadGenres(env, ctx, spec) : null;
  if (genres && genres.byName.has(tag)) {
    const at = genres.byName.get(tag);
    const start = genres.rowAt[at];
    const list = genres.rows.subarray(start, start + genres.rowCnt[at]);
    picks = stridePick(list, RELATED_COUNT + 2, row).filter((value) => value !== row).slice(0, RELATED_COUNT);
  }
  if (!picks || !picks.length) {
    /* no tags on this title: fall back to a spread of the whole shelf */
    picks = strideNumbers(shelf.index.count, RELATED_COUNT, row, row);
  }

  const payloads = await readRows(env, spec, shelf.index, picks);
  const items = payloads.map((bytes) => {
    const parts = fieldsOf(bytes);
    const ident = parts[0];
    let cover = "";
    if (shelfName === "series") cover = parts[2] ? "/api/cover/" + pyQuote(ident) : "";
    else if (shelfName === "mangadex") cover = parts[2] ? "/api/dexcover/" + pyQuote(ident) : "";
    else cover = parts[3] || "";
    return { ident, title: parts[1], cover };
  });
  return {
    label: tag ? "More " + tag : "More from " + shelfInfo(shelfName).label,
    items,
  };
}

async function titlePageResponse(env, ctx, url) {
  const rest = url.pathname.slice("/t/".length);
  const cut = rest.indexOf("/");
  const origin = url.origin;
  if (cut <= 0) {
    return htmlResponse(404, notFoundPage({ origin, shelf: null, ident: "" }), "noindex, follow");
  }
  const shelfName = rest.slice(0, cut);
  let ident = rest.slice(cut + 1).replace(/\/+$/, "");
  try {
    ident = decodeURIComponent(ident);
  } catch (err) {
    ident = "";
  }
  const known = shelfName === "catalog" || Object.prototype.hasOwnProperty.call(PAGE_SHELVES, shelfName);
  if (!known || !ident || ident.indexOf("/") !== -1 || !SLUG_RE.test(ident)) {
    return htmlResponse(404, notFoundPage({ origin, shelf: known ? shelfName : null, ident }), "noindex, follow");
  }

  const cache = caches.default;
  const cacheKey = new Request(origin + url.pathname + "?v=" + PAGE_CACHE_TAG);
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  /* Everything this page will need, fetched together: the row index, the id
     index, the meta offset table and the genre index.  Serially these were four
     round trips before the first byte of HTML. */
  const spec = PAGE_SHELVES[shelfName];
  if (spec) {
    try {
      const shell = await loadShell(env, ctx, spec);
      await Promise.all([
        ensureIds(env, ctx, shell),
        loadMetaIndex(env, ctx, spec),
        loadGenres(env, ctx, spec),
      ]);
    } catch (err) {
      /* a missing side file only costs the related grid, not the page */
    }
  }

  let built = null;
  try {
    built = await bookFor(env, ctx, url, shelfName, ident);
  } catch (err) {
    return htmlResponse(503, notFoundPage({ origin, shelf: shelfName, ident }), "noindex, follow");
  }
  if (!built) {
    return htmlResponse(404, notFoundPage({ origin, shelf: shelfName, ident }), "noindex, follow");
  }

  const book = built.book;
  /* The mangagg shelf carries no synopsis at all, so its pages are a cover and
     a link.  They stay reachable and shareable, but there is nothing there worth
     a search result, and saying so is better than being judged thin. */
  const thin = !book.description && !(book.tags && book.tags.length);
  let related = { label: "", items: [] };
  try {
    related = await relatedFor(env, ctx, shelfName, built.row, book.tags);
  } catch (err) {
    related = { label: "", items: [] };
  }

  const html = titlePage({
    origin,
    shelf: shelfName,
    book,
    related: related.items,
    relatedLabel: related.label,
    noindex: thin,
  });
  const response = htmlResponse(200, html, thin ? "noindex, follow" : "");
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

function htmlResponse(status, body, robots) {
  const headers = {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "public, max-age=600, s-maxage=86400",
  };
  if (robots) headers["X-Robots-Tag"] = robots;
  return new Response(body, { status, headers });
}

/* ---------- responses ---------- */

function json(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
      /* robots.txt asks crawlers off /api/*; this is the header for the ones
         that never read robots.txt but still honour noindex */
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

/* ---------- per-IP limits ----------
   The [[ratelimits]] binding deploys but never counts on a workers.dev host, so
   the counting happens here: an isolate-local counter for the common case and
   an edge cache counter beside it, both bucketed by the minute so a window
   always closes.  Under heavy concurrency the cached count can lose writes --
   it is a brake on one noisy client, not a security boundary. */
const PAGE_LIMIT = 90;
const COVER_LIMIT = 400;
const localCounters = new Map();

function bumpLocal(key, bucket) {
  const slot = localCounters.get(key);
  if (!slot || slot.bucket !== bucket) {
    if (localCounters.size > 5000) localCounters.clear();
    localCounters.set(key, { bucket: bucket, n: 1 });
    return 1;
  }
  slot.n += 1;
  return slot.n;
}

async function overLimit(env, ctx, kind, ip) {
  const limit = kind === "cover" ? COVER_LIMIT : kind === "image" ? IMAGE_LIMIT : PAGE_LIMIT;
  const bucket = Math.floor(Date.now() / 60000);
  if (bumpLocal(kind + ":" + ip, bucket) > limit) return true;
  const cacheKey = new Request("https://limit.internal/" + kind + "/" + encodeURIComponent(ip) + "/" + bucket);
  const cache = caches.default;
  let used = 0;
  try {
    const hit = await cache.match(cacheKey);
    if (hit) used = Number(await hit.text()) || 0;
  } catch (err) {
    return false;                     /* no cache: the local counter is all we have */
  }
  if (used >= limit) return true;
  try {
    ctx.waitUntil(
      cache.put(cacheKey, new Response(String(used + 1), { headers: { "Cache-Control": "public, max-age=120" } }))
    );
  } catch (err) {
    /* ignore */
  }
  return false;
}

function tooMany() {
  return new Response(JSON.stringify({ error: "too many requests — slow down and try again shortly" }), {
    status: 429,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
      "Retry-After": "60",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

function parseInt_(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/* ---------- visits ----------
   One anonymous ping per page load.  The client sends only a random id from its
   own localStorage and whether that id is new, so nothing here identifies a
   person; the count is written as one small JSON object per day. */
function dayKey(offset) {
  return new Date(Date.now() - (offset || 0) * 86400000).toISOString().slice(0, 10);
}

async function readDay(env, day) {
  try {
    const obj = await env.BUCKET.get("stats/" + day + ".json");
    return obj ? JSON.parse(await obj.text()) : null;
  } catch (err) {
    return null;
  }
}

async function recordVisit(env, request) {
  let body = {};
  try {
    body = await request.json();
  } catch (err) {
    body = {};
  }
  const fresh = body && body.fresh ? 1 : 0;
  const day = dayKey(0);
  const stats = (await readDay(env, day)) || { views: 0, fresh: 0, returning: 0 };
  stats.views = (stats.views || 0) + 1;
  const field = fresh ? "fresh" : "returning";
  stats[field] = (stats[field] || 0) + 1;
  try {
    await env.BUCKET.put("stats/" + day + ".json", JSON.stringify(stats));
  } catch (err) {
    /* a lost count is not worth failing a page over */
  }
  return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*" } });
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

async function statsPage(env) {
  const days = [];
  for (let i = 0; i < 30; i++) days.push(dayKey(i));
  const rows = await Promise.all(days.map((day) => readDay(env, day)));
  let total = 0;
  let fresh = 0;
  let back = 0;
  for (const row of rows) {
    if (!row) continue;
    total += row.views || 0;
    fresh += row.fresh || 0;
    back += row.returning || 0;
  }
  const peak = Math.max(1, ...rows.map((row) => (row ? row.views || 0 : 0)));
  const lines = rows.map((row, index) => {
    const views = row ? row.views || 0 : 0;
    if (!views) return "";
    const bar = Math.round((views / peak) * 120);
    return '<tr><td>' + days[index] + "</td><td class=\"n\">" + views +
      '</td><td class="bar"><span style="width:' + bar + 'px"></span></td><td class="n">' +
      (row.fresh || 0) + '</td><td class="n">' + (row.returning || 0) + "</td></tr>";
  }).filter(Boolean).join("");

  const pct = total ? Math.round((back / total) * 100) : 0;
  const body = "<!doctype html><meta charset=utf-8><title>visits</title>" +
    "<meta name=robots content=noindex><meta name=viewport content='width=device-width,initial-scale=1'>" +
    "<style>body{margin:0;background:#0a0c11;color:#cbd5e1;font:14px/1.6 ui-sans-serif,system-ui,-apple-system,\"Segoe UI\",Roboto,sans-serif;padding:28px 20px}" +
    "h1{font-size:13px;letter-spacing:.16em;text-transform:uppercase;color:#e2e8f0;margin:0 0 4px}" +
    "p.sub{margin:0 0 22px;color:#64748b;font-size:12px}" +
    ".cards{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:26px}" +
    ".card{border:1px solid rgba(148,163,184,.18);background:rgba(148,163,184,.05);border-radius:12px;padding:12px 16px;min-width:130px}" +
    ".card .k{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#64748b}" +
    ".card .v{font-size:22px;font-weight:700;color:#eaf7ff;font-variant-numeric:tabular-nums}" +
    "table{border-collapse:collapse;width:100%;max-width:620px;font-variant-numeric:tabular-nums}" +
    "th{text-align:left;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#64748b;font-weight:600;padding:0 10px 8px 0}" +
    "td{padding:5px 10px 5px 0;border-top:1px solid rgba(148,163,184,.09);font-size:13px;color:#c3d0de}" +
    "td.n{text-align:right;padding-right:16px}" +
    "td.bar span{display:inline-block;height:7px;border-radius:4px;background:rgba(56,189,248,.5)}" +
    "p.empty{color:#64748b}" +
    "</style><h1>visits</h1><p class=sub>page loads, last 30 days &middot; this page is not counted</p>" +
    '<div class=cards><div class=card><div class=k>views 30d</div><div class=v>' + total + "</div></div>" +
    "<div class=card><div class=k>new visitors</div><div class=v>" + fresh + "</div></div>" +
    "<div class=card><div class=k>returning</div><div class=v>" + back + "</div></div>" +
    "<div class=card><div class=k>came back</div><div class=v>" + pct + "%</div></div></div>" +
    (lines
      ? "<table><tr><th>day</th><th>views</th><th></th><th>new</th><th>returning</th></tr>" + lines + "</table>"
      : "<p class=empty>no visits recorded yet</p>");

  return new Response(body, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

/* ---------- the reader ----------
   Chapter 1's page lists are crawled into one JSON per first letter (see
   reader_scraper.py) and uploaded with the rest of the data.  A title outside
   the crawl -- or one whose first chapter sits at a different URL -- is read
   from mgeko on demand and kept in the colo cache, so the reader works for the
   whole catalogue from day one rather than after a seven-thousand-title crawl. */
const READER_TTL_MS = 21600000;
const CHAPTER_TTL_MS = 21600000;
const CHAPTER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/;

function readerPayload(data) {
  return {
    slug: data.slug,
    title: data.title,
    chapter: String(data.chapter || "1"),
    cover: data.cover || "",
    count: data.images.length,
    images: data.images,
    chapters: Array.isArray(data.chapters) ? data.chapters : [],
    source: data.source || "",
    /* the reader builds every link it owns from these, so a mangagg chapter
       stays under /reader/series instead of falling back to mgeko */
    base: data.base || "/reader",
    api: data.api || "/api/reader",
  };
}

async function readerChunk(env, ctx, slug) {
  const letter = /^[a-z0-9]/.test(slug) ? slug[0] : "_";
  const key = (dataVersion || "e" + dataEpoch) + ":" + letter;
  if (readerChunks.has(key)) return readerChunks.get(key);
  let map = null;
  try {
    map = JSON.parse(text(await cachedBytes(env, ctx, "reader/" + letter + ".json")));
  } catch (err) {
    map = null;
  }
  if (map) {
    readerChunks.set(key, map);
    if (readerChunks.size > 40) readerChunks.delete(readerChunks.keys().next().value);
  }
  return map;
}

function readerHit(record, slug) {
  if (!record || !Array.isArray(record.i) || !record.i.length) return null;
  return {
    slug,
    title: record.t || slug,
    chapter: String(record.c || "1"),
    source: record.s || "",
    images: record.i,
  };
}

async function fetchMgekoText(url) {
  const response = await fetch(url, {
    headers: Object.assign({ Referer: "https://www.mgeko.cc/" }, READER_HEADERS),
    signal: AbortSignal.timeout(READER_TIMEOUT),
  });
  if (!response.ok) return "";
  return await response.text();
}

async function liveReader(slug, chapter) {
  chapter = String(chapter || "1");
  const direct = "https://www.mgeko.cc/reader/en/" + slug + "-chapter-" + chapter + "-eng-li/";
  let html = await fetchMgekoText(direct);
  let data = parseChapter(html, slug, chapter);
  data.source = direct;
  if (!data.images.length && chapter === "1") {
    /* chapter 1 is not always at the predictable URL: the series page names the
       first chapter, which also covers a title whose reader slug was renamed.
       Later chapters always use the token from their own reader URL. */
    const series = await fetchMgekoText(MGEKO_BASE + slug + "/");
    const match = /href="(\/reader\/en\/[^"]*?-chapter-[^"]+)"/i.exec(series);
    if (match) {
      const chapterUrl = "https://www.mgeko.cc" + match[1];
      html = await fetchMgekoText(chapterUrl);
      data = parseChapter(html, slug, chapterFromUrl(chapterUrl));
      data.source = chapterUrl;
    }
  }
  if (!data.images.length) return null;
  data.slug = slug;
  return data;
}

/* The chapter list lives only on mgeko's reader page, so it is cached apart
   from any single chapter: one title's list serves every chapter of it. */
function chapterCacheKey(slug) {
  return new Request("https://reader.internal/chapters2/" + encodeURIComponent(slug));
}

async function cachedChapters(slug) {
  try {
    const hit = await caches.default.match(chapterCacheKey(slug));
    return hit ? await hit.json() : [];
  } catch (err) {
    return [];
  }
}

async function chapterList(env, ctx, slug) {
  const known = await cachedChapters(slug);
  if (known.length) return known;
  const live = await liveReader(slug, "1");
  const list = live && live.chapters ? live.chapters : [];
  if (list.length) {
    try {
      ctx.waitUntil(
        caches.default.put(chapterCacheKey(slug), new Response(JSON.stringify(list), {
          headers: { "Cache-Control": "public, max-age=" + Math.round(CHAPTER_TTL_MS / 1000) },
        }))
      );
    } catch (err) {
      /* ignore */
    }
  }
  return list;
}

/* A notification must never trust the six-hour chapter-list cache: the cron
   runs right after the catalogue is refreshed, and a list cached just before
   that refresh would still end at the previous chapter.  Read chapter 1 live
   for the changed titles only. */
async function freshChapterList(slug) {
  const live = await liveReader(slug, "1");
  return live && Array.isArray(live.chapters) ? live.chapters : [];
}

async function readerData(env, ctx, slug, chapter) {
  chapter = String(chapter || "1");
  if (chapter === "1") {
    const chunk = await readerChunk(env, ctx, slug);
    const hit = readerHit(chunk && chunk[slug], slug);
    if (hit) {
      hit.chapters = await cachedChapters(slug);
      return hit;
    }
  }

  const cache = caches.default;
  const cacheKey = new Request(
    "https://reader.internal/v9/" + encodeURIComponent(slug) +
    (chapter === "1" ? "" : "/" + encodeURIComponent(chapter))
  );
  try {
    const cached = await cache.match(cacheKey);
    if (cached) return await cached.json();
  } catch (err) {
    /* cache unavailable: read mgeko */
  }
  const live = await liveReader(slug, chapter);
  if (!live) return null;
  const payload = readerPayload(live);
  try {
    ctx.waitUntil(
      cache.put(cacheKey, new Response(JSON.stringify(payload), {
        headers: { "Cache-Control": "public, max-age=" + Math.round(READER_TTL_MS / 1000) },
      }))
    );
    if (payload.chapters.length) {
      ctx.waitUntil(
        cache.put(chapterCacheKey(slug), new Response(JSON.stringify(payload.chapters), {
          headers: { "Cache-Control": "public, max-age=" + Math.round(CHAPTER_TTL_MS / 1000) },
        }))
      );
    }
  } catch (err) {
    /* ignore */
  }
  return payload;
}

/** Split /reader/<slug> or /reader/<slug>/<chapter> without guessing at the
    hyphen-heavy slugs; the chapter is always the last segment. */
function readerTarget(path, prefix) {
  let rest;
  try {
    rest = decodeURIComponent(path.slice(prefix.length));
  } catch (err) {
    return null;
  }
  rest = rest.replace(/\/+$/, "");
  const cut = rest.lastIndexOf("/");
  let slug = rest;
  let chapter = "1";
  if (cut !== -1) {
    slug = rest.slice(0, cut);
    chapter = rest.slice(cut + 1);
  }
  if (!slug || !SLUG_RE.test(slug) || !CHAPTER_RE.test(chapter)) return null;
  return { slug, chapter };
}

function notFoundReader(target, base) {
  const chapter = target && target.chapter ? target.chapter : "1";
  const slug = target && target.slug ? target.slug : "";
  const root = base || "/reader";
  const retry = chapter !== "1" && slug
    ? "<p><a href=\"" + root + "/" + slug + "\">start at chapter 1</a></p>"
    : "<p><a href=\"/\">back to the shelves</a></p>";
  return new Response(
    "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'>" +
    "<title>chapter not found</title><style>body{margin:0;background:#07090c;color:#c3d0de;" +
    "font:15px/1.6 ui-sans-serif,system-ui,sans-serif;padding:48px 22px;text-align:center}a{color:#7dd3fc}</style>" +
    "<p>No chapter " + chapter + " was found for this title.</p>" + retry,
    {
      status: 404,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Robots-Tag": "noindex, nofollow",
      },
    }
  );
}

/* ---------- mangagg's reader ----------
   mangagg runs Madara, so a chapter is one document: every page is an
   <img class="wp-manga-chapter-img"> in order, served from s4.mangagg.com,
   which allows hotlinking.  That is the same one-GET contract the reader was
   built for, so it needs no images copied or streamed -- only its own routes,
   because a mangagg slug lives in a namespace of its own. */
const MANGAGG_COMIC = "https://mangagg.com/comic/";
const MANGAGG_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml",
  Referer: "https://mangagg.com/",
};

function mangaggDecode(text) {
  return String(text || "").replace(/&amp;/g, "&").replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, " ");
}

async function mangaggText(url) {
  try {
    const response = await fetch(url, {
      headers: MANGAGG_HEADERS,
      signal: AbortSignal.timeout(READER_TIMEOUT),
    });
    if (!response.ok) return "";
    return await response.text();
  } catch (err) {
    return "";
  }
}

function parseMangaggImages(html) {
  const images = [];
  const seen = new Set();
  const tags = html.match(/<img\b[^>]*>/gi) || [];
  for (const tag of tags) {
    if (tag.indexOf("wp-manga-chapter-img") === -1) continue;
    const found = /\bsrc\s*=\s*"([^"]*)"/i.exec(tag) || /\bdata-src\s*=\s*"([^"]*)"/i.exec(tag);
    if (!found) continue;
    let src = mangaggDecode(found[1]).trim();
    if (src.indexOf("//") === 0) src = "https:" + src;
    if (!/^https?:\/\//i.test(src) || seen.has(src)) continue;
    seen.add(src);
    images.push(src);
  }
  return images;
}

function parseMangaggChapters(html, slug) {
  const escaped = slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    'href="https://mangagg\\.com/comic/' + escaped + '/chapter-([0-9]+(?:\\.[0-9]+)?)/"', "gi"
  );
  const seen = new Set();
  const out = [];
  let match;
  while ((match = re.exec(html))) {
    const token = match[1];
    if (seen.has(token)) continue;
    seen.add(token);
    out.push({ n: token, l: token });
  }
  out.sort((a, b) => {
    const na = Number(a.n);
    const nb = Number(b.n);
    if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
    return String(a.n).localeCompare(String(b.n));
  });
  return out;
}

function mangaggTitle(html, slug) {
  const og = /<meta[^>]+property="og:title"[^>]+content="([^"]*)"/i.exec(html) ||
    /<meta[^>]+content="([^"]*)"[^>]+property="og:title"/i.exec(html);
  let title = og ? mangaggDecode(og[1]).trim() : "";
  title = title.replace(/\s*[|\u2013-]\s*(?:read\s+)?mangagg.*$/i, "").trim();
  if (!title) {
    const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
    if (h1) title = mangaggDecode(h1[1].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
  }
  return title || slug;
}

function mangaggChapterUrl(slug, chapter) {
  return MANGAGG_COMIC + encodeURIComponent(slug) + "/chapter-" + encodeURIComponent(chapter) + "/";
}

/* The comic page only prints its first and its latest chapter (the full list is
   behind admin-ajax, which answers 400 to anything but a browser).  mangagg's
   chapter URLs are plain numbers, so the range between those two is exactly the
   list -- merged with any named token the page did print, and capped so a
   malformed "latest" cannot produce a million options. */
async function mangaggChapterList(env, ctx, slug) {
  const key = new Request("https://reader.internal/mgchapters2/" + encodeURIComponent(slug));
  try {
    const hit = await caches.default.match(key);
    if (hit) return await hit.json();
  } catch (err) {
    /* cache unavailable: read the comic page */
  }
  const html = await mangaggText(MANGAGG_COMIC + encodeURIComponent(slug) + "/");
  const list = html ? parseMangaggChapters(html, slug) : [];
  const have = new Set(list.map((item) => String(item.n)));
  let latest = 0;
  for (const item of list) {
    const value = Number(item.n);
    if (Number.isFinite(value) && value > latest) latest = value;
  }
  if (latest > 1) {
    const cap = Math.min(Math.floor(latest), 2000);
    for (let n = 1; n <= cap; n++) {
      const token = String(n);
      if (have.has(token)) continue;
      have.add(token);
      list.push({ n: token, l: token });
    }
    list.sort((a, b) => {
      const na = Number(a.n);
      const nb = Number(b.n);
      if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
      return String(a.n).localeCompare(String(b.n));
    });
  }
  if (list.length) {
    try {
      ctx.waitUntil(caches.default.put(key, new Response(JSON.stringify(list), {
        headers: { "Cache-Control": "public, max-age=" + Math.round(CHAPTER_TTL_MS / 1000) },
      })));
    } catch (err) {
      /* ignore */
    }
  }
  return list;
}

async function liveMangaggReader(slug, chapter) {
  chapter = String(chapter || "1");
  let source = mangaggChapterUrl(slug, chapter);
  let html = await mangaggText(source);
  let data = {
    title: mangaggTitle(html, slug),
    chapter,
    images: parseMangaggImages(html),
    cover: "",
  };
  if (!data.images.length && chapter === "1") {
    /* a title's first chapter is not always chapter-1: the comic page names
       it, and that is also what fixes a renamed chapter-0 or prologue */
    const comic = await mangaggText(MANGAGG_COMIC + encodeURIComponent(slug) + "/");
    const first = parseMangaggChapters(comic, slug)[0];
    if (first) {
      source = mangaggChapterUrl(slug, first.n);
      html = await mangaggText(source);
      data = {
        title: mangaggTitle(html, slug) || mangaggTitle(comic, slug),
        chapter: first.n,
        images: parseMangaggImages(html),
        cover: "",
      };
    }
  }
  if (!data.images.length) return null;
  data.slug = slug;
  data.source = source;
  data.base = "/reader/series";
  data.api = "/api/reader/series";
  return data;
}

async function mangaggReaderData(env, ctx, slug, chapter) {
  chapter = String(chapter || "1");
  const key = new Request(
    "https://reader.internal/mg/v3/" + encodeURIComponent(slug) + "/" + encodeURIComponent(chapter)
  );
  try {
    const hit = await caches.default.match(key);
    if (hit) return await hit.json();
  } catch (err) {
    /* cache unavailable */
  }
  const live = await liveMangaggReader(slug, chapter);
  if (!live) return null;
  live.chapters = await mangaggChapterList(env, ctx, slug);
  /* history and continue cards read reader-meta, so the reader has to hand
     them the same cover the shelves use */
  if (!live.cover) live.cover = "/api/cover/" + encodeURIComponent(slug);
  const payload = readerPayload(live);
  try {
    ctx.waitUntil(caches.default.put(key, new Response(JSON.stringify(payload), {
      headers: { "Cache-Control": "public, max-age=" + Math.round(READER_TTL_MS / 1000) },
    })));
  } catch (err) {
    /* ignore */
  }
  return payload;
}

async function mangaggReaderResponse(env, ctx, url) {
  return readerShell(env, url);
}

async function mangaggReaderApi(env, ctx, url) {
  const rest = url.pathname.slice("/api/reader/series/".length).replace(/\/+$/, "");
  if (rest.endsWith("/chapters")) {
    let slug = "";
    try {
      slug = decodeURIComponent(rest.slice(0, -9));
    } catch (err) {
      slug = "";
    }
    if (!slug || !SLUG_RE.test(slug)) return json(400, { error: "bad slug" });
    try {
      const chapters = await mangaggChapterList(env, ctx, slug);
      return new Response(JSON.stringify({ slug, chapters }), {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "public, max-age=600",
          "X-Robots-Tag": "noindex, nofollow",
        },
      });
    } catch (err) {
      return json(502, { error: "chapters unavailable: " + err.message });
    }
  }
  const target = readerTarget(url.pathname, "/api/reader/series/");
  if (!target) return json(400, { error: "bad slug" });
  try {
    const data = await mangaggReaderData(env, ctx, target.slug, target.chapter);
    if (!data) return json(404, { error: "no chapter " + target.chapter + " for " + target.slug });
    return new Response(JSON.stringify(data), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=600",
        "X-Robots-Tag": "noindex, nofollow",
      },
    });
  } catch (err) {
    return json(502, { error: "reader unavailable: " + err.message });
  }
}

/* The reader page is now the UI copy's client-side shell.  It asks for one
   story payload per chapter; main still owns the chapters and images, so this
   bridge hands the shell the current chapter's pages plus the chapter list.
   Only the open chapter carries pages: every picker row is a real link, so
   the next chapter gets its pages from this same route on navigation. */
async function readerStoryJson(env, ctx, url) {
  let rest = url.pathname.slice("/api/reader_data/".length).replace(/\/+$/, "");
  if (rest.indexOf("harvest/") === 0) return harvestStoryJson(env, ctx, rest, url);
  let series = false;
  if (rest.indexOf("series/") === 0) {
    series = true;
    rest = rest.slice("series/".length);
  }
  if (!rest.endsWith("/story.json")) return json(404, { error: "not found" });
  let slug = rest.slice(0, -"/story.json".length);
  try {
    slug = decodeURIComponent(slug);
  } catch (err) {
    return json(400, { error: "bad slug" });
  }
  if (!slug || slug.indexOf("/") !== -1 || !SLUG_RE.test(slug)) return json(400, { error: "bad slug" });
  let chapter = url.searchParams.get("chapter") || "1";
  if (!CHAPTER_RE.test(chapter)) chapter = "1";
  const data = series
    ? await mangaggReaderData(env, ctx, slug, chapter)
    : await readerData(env, ctx, slug, chapter);
  if (!data) return json(404, { error: "no chapter " + chapter });
  let chapters = Array.isArray(data.chapters) ? data.chapters.slice() : [];
  if (!chapters.length) {
    chapters = series
      ? await mangaggChapterList(env, ctx, slug)
      : await chapterList(env, ctx, slug);
  }
  const images = Array.isArray(data.images) ? data.images : [];
  const pages = images.map((src) => ({ src, w: 0, h: 0 }));
  const current = String(data.chapter || chapter);
  const built = chapters.map((item) => ({
    n: String(item.n),
    l: String(item.l || item.n),
    pages: String(item.n) === current ? pages : [],
  }));
  if (!built.some((item) => item.n === current)) {
    built.unshift({ n: current, l: current, pages });
  }
  return new Response(JSON.stringify({
    slug,
    title: data.title || slug,
    chapter: current,
    source: data.source || "",
    cover: data.cover || "/api/cover/" + encodeURIComponent(slug),
    pageCount: images.length,
    chapters: built,
  }), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=300",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

/* ---------- harvested chapters ----------
   kunmanga and bato1 chapters stay on their own sites, so there is no local
   page list: the shard says which chapter tokens exist, and one fetch of the
   chapter page (cached in R2 after the first reader) says which images it
   holds.  kunmanga pages answer only a kunmanga referer and its images only a
   kunmanga referer too, so those go back out through /img/kun; bato1's CDN
   hotlinks. */
const HARVEST_SOURCES = {
  kun: {
    site: "kunmanga",
    referer: "https://www.kunmanga.online/",
    page: (slug, chapter) => "https://www.kunmanga.online/manga/" + slug + "/chapter-" + chapter,
  },
  bato: {
    site: "bato1",
    referer: null,
    page: (slug, chapter) => "https://bato1.co.uk/read/" + slug + "/chapter-" + chapter,
  },
  comick: {
    site: "comick",
    referer: "https://comick.live/",
    page: (slug, chapter, label) => "https://comick.live/comic/" + slug + "/" +
      encodeURIComponent(chapter) + "-chapter-" + encodeURIComponent(label) + "-en",
  },
};
const HARVEST_SHELF = "/#library";

function harvestShardOf(slug) {
  const first = String(slug || "").slice(0, 1).toLowerCase();
  return /[a-z0-9]/.test(first) ? first : "_";
}

async function harvestShard(env, ctx, source, slug) {
  const bytes = await cachedBytes(env, ctx, "harvest/ch/" + source + "-" + harvestShardOf(slug) + ".json");
  const all = JSON.parse(text(bytes));
  return all && all[slug] ? all[slug] : null;
}

function harvestChapterList(entry) {
  const tokens = entry && Array.isArray(entry.c) ? entry.c : [];
  return tokens.map((token) => (Array.isArray(token)
    ? { n: String(token[0]), l: String(token[1] || token[0]) }
    : { n: String(token), l: String(token) }));
}

function htmlAttr(tag, name) {
  const match = new RegExp("(?:^|\\s)" + name + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))", "i").exec(tag);
  return match ? (match[1] != null ? match[1] : match[2] != null ? match[2] : match[3] || "") : "";
}

function htmlText(value) {
  return String(value || "").replace(/&amp;/g, "&").replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

function kunChapterImages(html) {
  const out = [];
  const seen = new Set();
  for (const tag of html.match(/<img\b[^>]*>/gi) || []) {
    if (!/\bwp-manga-chapter-img\b/.test(htmlAttr(tag, "class"))) continue;
    let src = htmlText(htmlAttr(tag, "src") || htmlAttr(tag, "data-src")).trim();
    if (src.indexOf("//") === 0) src = "https:" + src;
    let url;
    try { url = new URL(src); } catch (err) { continue; }
    if (!/^https?:$/.test(url.protocol)) continue;
    const host = url.hostname.toLowerCase();
    if (!IMAGE_SOURCES.kun.hosts.includes(host)) continue;
    const proxied = "/img/kun/" + host + url.pathname;
    if (seen.has(proxied)) continue;
    seen.add(proxied);
    out.push(proxied);
  }
  return out;
}

function batoChapterImages(html) {
  const numbered = [];
  const seen = new Set();
  for (const tag of html.match(/<img\b[^>]*>/gi) || []) {
    if (!/\bimage-thumb\b/.test(htmlAttr(tag, "class"))) continue;
    const number = htmlAttr(tag, "data-number");
    if (!/^[0-9]+$/.test(number)) continue;
    const src = htmlText(htmlAttr(tag, "data-src") || htmlAttr(tag, "data-fallback") || htmlAttr(tag, "src")).trim();
    let url;
    try { url = new URL(src); } catch (err) { continue; }
    if (!/^https?:$/.test(url.protocol)) continue;
    if (!/(^|\.)snapvip\.xyz$/i.test(url.hostname)) continue;
    if (seen.has(url.href)) continue;
    seen.add(url.href);
    numbered.push([Number(number), url.href]);
  }
  numbered.sort((a, b) => a[0] - b[0]);
  return numbered.map((pair) => pair[1]);
}

async function harvestChapterImages(env, ctx, source, chapterUrl) {
  const spec = HARVEST_SOURCES[source];
  /* every source hands in the page that carries its page list: kunmanga and
     bato1 render it into HTML, comick.live embeds it as JSON in the chapter
     page the caller builds from the slug and the chapter label */
  const upstream = chapterUrl;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(upstream));
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  const key = "himg/" + source + "/" + hex + ".json";
  try {
    const stored = await env.BUCKET.get(key);
    if (stored) return JSON.parse(text(new Uint8Array(await stored.arrayBuffer())));
  } catch (err) { /* fall through to the source */ }

  const headers = Object.assign({}, IMAGE_HEADERS, {
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  });
  if (spec.referer) headers.Referer = spec.referer;
  let response;
  try {
    response = await fetch(upstream, { headers });
  } catch (err) {
    return null;
  }
  if (!response.ok) return null;
  const body = await response.text();
  let images;
  if (source === "comick") {
    /* the chapter page carries its page list as JSON with escaped slashes; the
       urls are all the reader needs, and the covers are not pages */
    const flat = body.replace(/\\\//g, "/");
    images = [];
    const seen = new Set();
    for (const match of flat.match(/https:\/\/cdn\d+\.comicknew\.pictures\/[A-Za-z0-9._~!$&'()*+,;=:@%\/-]+\.webp/g) || []) {
      if (match.includes("/covers/")) continue;
      let url;
      try { url = new URL(match); } catch (err) { continue; }
      const host = url.hostname.toLowerCase();
      if (!IMAGE_SOURCES.comick.hosts.includes(host)) continue;
      const proxied = "/img/comick/" + host + url.pathname;
      if (seen.has(proxied)) continue;
      seen.add(proxied);
      images.push(proxied);
    }
  } else {
    images = source === "kun" ? kunChapterImages(body) : batoChapterImages(body);
  }
  if (!images.length) return null;
  const payload = { images };
  try {
    ctx.waitUntil(env.BUCKET.put(key, JSON.stringify(payload), {
      httpMetadata: { contentType: "application/json" },
    }));
  } catch (err) { /* a cache miss next time, not a failed read */ }
  return payload;
}

function harvestTarget(pathname, prefix) {
  let rest = pathname.slice(prefix.length).replace(/\/+$/, "");
  const wantsChapters = rest.endsWith("/chapters");
  if (wantsChapters) rest = rest.slice(0, -"/chapters".length);
  const parts = rest.split("/").filter(Boolean).map((part) => {
    try { return decodeURIComponent(part); } catch (err) { return ""; }
  });
  if (parts.length < 2) return null;
  const [source, slug, chapter] = parts;
  if (!HARVEST_SOURCES[source] || !SLUG_RE.test(slug)) return null;
  return { source, slug, chapter: chapter || "", wantsChapters };
}

async function harvestChapter(env, ctx, target) {
  const entry = await harvestShard(env, ctx, target.source, target.slug);
  if (!entry) return null;
  const chapters = harvestChapterList(entry);
  if (!chapters.length) return null;
  let chapter = chapters[0].n;
  if (target.chapter) {
    if (!chapters.some((item) => item.n === target.chapter)) return null;
    chapter = target.chapter;
  }
  const spec = HARVEST_SOURCES[target.source];
  const label = (chapters.find((item) => item.n === chapter) || {}).l || chapter;
  const fetched = await harvestChapterImages(env, ctx, target.source,
    spec.page(target.slug, chapter, label));
  if (!fetched) return null;
  return {
    slug: target.slug,
    title: entry.t || target.slug,
    chapter,
    images: fetched.images,
    chapters,
    cover: entry.v || "",
    source: entry.u || "",
    site: spec.site,
  };
}

async function harvestReaderResponse(env, ctx, url) {
  const target = harvestTarget(url.pathname, "/reader/harvest/");
  if (!target) return new Response("not found", { status: 404, headers: { "Content-Type": "text/plain" } });
  /* the same reader.html the other shelves use: it fetches
     /api/reader_data/harvest/<source>/<slug>/story.json itself, so the old
     server-rendered reader stays gone */
  return readerShell(env, url);
}

/* The new reader's data route for a harvested chapter.  Only the open chapter
   carries pages; every picker row is a real link, so the next chapter asks for
   its own story.json. */
async function harvestStoryJson(env, ctx, rest, url) {
  if (!rest.endsWith("/story.json")) return json(404, { error: "not found" });
  const core = rest.slice("harvest/".length, -"/story.json".length);
  const parts = core.split("/").filter(Boolean);
  if (parts.length < 2) return json(400, { error: "bad slug" });
  const source = parts[0];
  let slug = parts[1];
  try {
    slug = decodeURIComponent(slug);
  } catch (err) {
    return json(400, { error: "bad slug" });
  }
  if (!HARVEST_SOURCES[source] || !SLUG_RE.test(slug)) return json(400, { error: "bad slug" });
  /* comick's chapter tokens are hids, not numbers, so the mgeko CHAPTER_RE is
     too narrow here: keep the same character set the route allows instead */
  const wanted = (url.searchParams.get("chapter") || "").replace(/[^A-Za-z0-9._-]/g, "");
  const data = await harvestChapter(env, ctx, { source, slug, chapter: wanted });
  if (!data) return json(404, { error: "no chapter" });
  const pages = data.images.map((src) => ({ src, w: 0, h: 0 }));
  const current = String(data.chapter);
  const built = data.chapters.map((item) => ({
    n: String(item.n),
    l: String(item.l || item.n),
    pages: String(item.n) === current ? pages : [],
  }));
  return new Response(JSON.stringify({
    slug,
    title: data.title,
    chapter: current,
    source: data.source || "",
    cover: data.cover || "",
    pageCount: pages.length,
    chapters: built,
  }), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=300",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

async function harvestReaderApi(env, ctx, url) {
  const target = harvestTarget(url.pathname, "/api/reader/harvest/");
  if (!target) return json(400, { error: "bad chapter" });
  try {
    if (target.wantsChapters) {
      const entry = await harvestShard(env, ctx, target.source, target.slug);
      if (!entry) return json(404, { error: "no title" });
      return new Response(JSON.stringify({ slug: target.slug, chapters: harvestChapterList(entry) }), {
        headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" },
      });
    }
    const data = await harvestChapter(env, ctx, target);
    if (!data) return json(404, { error: "no chapter" });
    return new Response(JSON.stringify(data), {
      headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" },
    });
  } catch (err) {
    return json(502, { error: "reader unavailable: " + err.message });
  }
}

async function readerShell(env, url) {
  const asset = await env.ASSETS.fetch(new Request(new URL("/reader.html", url)));
  if (!asset.ok) return new Response("Reader unavailable", { status: 404 });
  return new Response(asset.body, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

async function readerResponse(env, ctx, url) {
  return readerShell(env, url);
}

async function readerApiResponse(env, ctx, url) {
  const rest = url.pathname.slice("/api/reader/".length).replace(/\/+$/, "");
  if (rest.endsWith("/chapters")) {
    let slug = "";
    try {
      slug = decodeURIComponent(rest.slice(0, -9));
    } catch (err) {
      slug = "";
    }
    if (!slug || !SLUG_RE.test(slug)) return json(400, { error: "bad slug" });
    try {
      const chapters = await chapterList(env, ctx, slug);
      return new Response(JSON.stringify({ slug, chapters }), {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "public, max-age=600",
          "X-Robots-Tag": "noindex, nofollow",
        },
      });
    } catch (err) {
      return json(502, { error: "chapters unavailable: " + err.message });
    }
  }

  const target = readerTarget(url.pathname, "/api/reader/");
  if (!target) return json(400, { error: "bad slug" });
  try {
    const data = await readerData(env, ctx, target.slug, target.chapter);
    if (!data) return json(404, { error: "no chapter " + target.chapter + " for " + target.slug });
    return new Response(JSON.stringify(readerPayload(data)), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=600",
        "X-Robots-Tag": "noindex, nofollow",
      },
    });
  } catch (err) {
    return json(502, { error: "reader unavailable: " + err.message });
  }
}

async function handlePage(env, ctx, spec, url) {
  const offset = Math.max(0, parseInt_(url.searchParams.get("offset"), 0));
  const limit = Math.min(200, Math.max(1, parseInt_(url.searchParams.get("limit"), 48)));
  const query = url.searchParams.get("q") || "";
  let sort = url.searchParams.get("sort") || "";
  if (spec && !spec.sorts.includes(sort)) sort = "";
  if (!spec) sort = "";
  const minYear = Math.max(0, parseInt_(url.searchParams.get("minYear"), 0));
  const started = Date.now();

  /* A sorted page is not one read: the rows it wants are scattered through the
     file in rank order, so it is up to 18 small ranged GETs whose total is the
     slowest of them (200-500 ms).  The result is the same for every reader on
     the same query, so it goes in the colo cache and the next person -- and the
     next tab switch, and the back button -- gets it in a few milliseconds.  The
     counts only move when the data is re-uploaded, and 30 s is short enough that
     a re-upload is not a wait anyone notices. */
  const cache = caches.default;
  const cacheKey = new Request(
    "https://pages.internal/" + (spec ? spec.name : "catalog") +
    "?q=" + encodeURIComponent(normalize(query)) + "&o=" + offset + "&n=" + limit +
    "&s=" + sort + "&y=" + minYear
  );
  try {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  } catch (err) {
    /* cache unavailable: fall through and build it */
  }

  try {
    const result = spec
      ? await pageShelf(env, ctx, spec, query, offset, limit, sort, minYear)
      : await pageCatalog(env, ctx, query, offset, limit);
    const payload = { total: result.total, offset, limit, items: result.items };
    const body = JSON.stringify(payload);
    const headers = {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=30",
      "X-Robots-Tag": "noindex, nofollow",
    };
    ctx.waitUntil(cache.put(cacheKey, new Response(body, { headers })));
    return new Response(
      JSON.stringify(Object.assign({}, payload, { elapsed_ms: Date.now() - started })),
      { headers: Object.assign({}, headers, { "Cache-Control": "no-store" }) }
    );
  } catch (err) {
    return json(500, { error: (spec ? spec.name : "catalog") + " unavailable: " + err.message });
  }
}

/* ---------- web push ----------
   Opt-in chapter notifications.  A subscription lives in R2 under a hash of its
   endpoint, next to the last chapter count this device saw.  The cron compares
   that count with the nightly catalogue and sends one notification per title
   that gained a chapter.  The payload is encrypted for that one subscription
   (RFC 8291) and signed with the VAPID key (RFC 8292), so no third-party push
   service ever sees a readable title. */
const PUSH_PREFIX = "push/sub/";
const PUSH_MAX_SLUGS = 300;
const PUSH_TTL_SECONDS = 86400;
const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/,
  /\.notify\.windows\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /\.push\.apple\.com$/,
];

function pushB64u(bytes) {
  let out = "";
  for (const byte of bytes) out += String.fromCharCode(byte);
  return btoa(out).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pushFromB64u(value) {
  const text = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = text + "=".repeat((4 - (text.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

function pushConcat(...parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

async function pushHkdf(salt, ikm, info, bytes) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8
  ));
}

async function pushDigest(value) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function pushVapid(env) {
  return {
    publicKey: String(env.VAPID_PUBLIC_KEY || ""),
    privateKey: String(env.VAPID_PRIVATE_KEY || ""),
    subject: String(env.VAPID_SUBJECT || "https://mgeko-tags.okcasa27.workers.dev/"),
  };
}

function pushConfigured(env) {
  const vapid = pushVapid(env);
  return Boolean(vapid.publicKey && vapid.privateKey);
}

async function pushVapidAuthorization(endpoint, vapid) {
  const publicBytes = pushFromB64u(vapid.publicKey);
  if (publicBytes.length !== 65 || publicBytes[0] !== 4) throw new Error("bad VAPID public key");
  const key = await crypto.subtle.importKey("jwk", {
    kty: "EC", crv: "P-256",
    x: pushB64u(publicBytes.slice(1, 33)),
    y: pushB64u(publicBytes.slice(33)),
    d: vapid.privateKey,
  }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const header = pushB64u(new TextEncoder().encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = {
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    sub: vapid.subject,
  };
  const body = pushB64u(new TextEncoder().encode(JSON.stringify(claims)));
  const unsigned = header + "." + body;
  const signature = new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(unsigned)
  ));
  return "vapid t=" + unsigned + "." + pushB64u(signature) + ", k=" + vapid.publicKey;
}

async function pushEncrypt(payload, subscription) {
  if (payload.length > 3993) throw new Error("push payload too large");
  const encoder = new TextEncoder();
  const uaPublic = pushFromB64u(subscription.keys.p256dh);
  const authSecret = pushFromB64u(subscription.keys.auth);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const server = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]
  );
  const serverPublic = new Uint8Array(await crypto.subtle.exportKey("raw", server.publicKey));
  const uaKey = await crypto.subtle.importKey(
    "raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []
  );
  const ecdh = { name: "ECDH", public: uaKey };
  const secret = new Uint8Array(await crypto.subtle.deriveBits(ecdh, server.privateKey, 256));
  const ikm = await pushHkdf(
    authSecret, secret,
    pushConcat(encoder.encode("WebPush: info\0"), uaPublic, serverPublic), 32
  );
  const cek = await pushHkdf(salt, ikm, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await pushHkdf(salt, ikm, encoder.encode("Content-Encoding: nonce\0"), 12);
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const cipher = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce }, aes,
    pushConcat(payload, new Uint8Array([2]))
  ));
  const header = new Uint8Array(86);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = 65;
  header.set(serverPublic, 21);
  return pushConcat(header, cipher);
}

async function pushSend(vapid, subscription, payload) {
  const body = await pushEncrypt(new TextEncoder().encode(payload), subscription);
  return fetch(subscription.endpoint, {
    method: "POST",
    headers: {
      Authorization: await pushVapidAuthorization(subscription.endpoint, vapid),
      TTL: String(PUSH_TTL_SECONDS),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
    },
    body,
  });
}

function pushValidSubscription(subscription) {
  if (!subscription || typeof subscription.endpoint !== "string" ||
      subscription.endpoint.length > 2048 || !subscription.keys) return false;
  let url = null;
  try { url = new URL(subscription.endpoint); } catch (err) { return false; }
  if (url.protocol !== "https:" || !PUSH_HOSTS.some((host) => host.test(url.hostname))) return false;
  try {
    const publicKey = pushFromB64u(subscription.keys.p256dh);
    const auth = pushFromB64u(subscription.keys.auth);
    return publicKey.length === 65 && publicKey[0] === 4 && auth.length === 16;
  } catch (err) {
    return false;
  }
}

function pushSlugs(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const slug of value) {
    if (typeof slug !== "string" || !SLUG_RE.test(slug) || seen.has(slug)) continue;
    seen.add(slug);
    out.push(slug);
    if (out.length >= PUSH_MAX_SLUGS) break;
  }
  return out;
}

async function readPushBody(request) {
  const raw = await request.text();
  if (!raw || raw.length > 65536) return null;
  try { return JSON.parse(raw); } catch (err) { return null; }
}

function pushKeyResponse(env) {
  if (!env.VAPID_PUBLIC_KEY) return json(503, { error: "notifications are not configured" });
  return json(200, { publicKey: String(env.VAPID_PUBLIC_KEY) });
}

async function pushSubscribeResponse(env, ctx, request) {
  if (!pushConfigured(env)) return json(503, { error: "notifications are not configured" });
  const body = await readPushBody(request);
  if (!body || !pushValidSubscription(body.subscription)) return json(400, { error: "bad subscription" });
  const slugs = pushSlugs(body.slugs);
  let rows = null;
  try { rows = await loadCatalog(env, ctx); } catch (err) { return json(503, { error: "catalogue unavailable" }); }
  const bySlug = catalogSlugIndex(rows);
  const key = PUSH_PREFIX + await pushDigest(body.subscription.endpoint);
  let old = null;
  try {
    const previous = await env.BUCKET.get(key);
    if (previous) old = JSON.parse(await previous.text());
  } catch (err) {
    old = null;
  }
  const oldSeen = old && old.seen && typeof old.seen === "object" ? old.seen : {};
  const seen = {};
  for (const slug of slugs) {
    const row = bySlug.get(slug);
    const current = row === undefined ? 0 : Number(rows[row][9]) || 0;
    seen[slug] = Object.prototype.hasOwnProperty.call(oldSeen, slug)
      ? Number(oldSeen[slug]) || 0
      : current;
  }
  const record = {
    subscription: {
      endpoint: body.subscription.endpoint,
      keys: { p256dh: body.subscription.keys.p256dh, auth: body.subscription.keys.auth },
    },
    slugs,
    seen,
    updatedAt: Date.now(),
  };
  await env.BUCKET.put(key, JSON.stringify(record), {
    httpMetadata: { contentType: "application/json" },
  });
  return json(200, { ok: true, watching: slugs.length });
}

async function pushUnsubscribeResponse(env, request) {
  const body = await readPushBody(request);
  if (!body || typeof body.endpoint !== "string") return json(400, { error: "bad endpoint" });
  await env.BUCKET.delete(PUSH_PREFIX + await pushDigest(body.endpoint));
  return json(200, { ok: true });
}

async function listPushSubscriptions(env) {
  const out = [];
  let cursor;
  do {
    const page = await env.BUCKET.list({ prefix: PUSH_PREFIX, cursor });
    for (const object of page.objects || []) {
      try {
        const stored = await env.BUCKET.get(object.key);
        if (!stored) continue;
        const record = JSON.parse(await stored.text());
        if (record && pushValidSubscription(record.subscription)) {
          out.push({ key: object.key, record });
        }
      } catch (err) {
        /* a broken subscription should not stop the rest */
      }
    }
    cursor = page.truncated ? page.cursor : null;
  } while (cursor);
  return out;
}

async function pushMapLimit(items, limit, work) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const at = next++;
      if (at >= items.length) return;
      await work(items[at]);
    }
  });
  await Promise.all(workers);
}

async function notifyChapterUpdates(env, ctx) {
  const vapid = pushVapid(env);
  if (!vapid.publicKey || !vapid.privateKey) {
    console.log("push: VAPID is not configured");
    return;
  }
  let rows = null;
  try { rows = await loadCatalog(env, ctx); } catch (err) {
    console.error("push: catalogue unavailable", err.message);
    return;
  }
  const bySlug = catalogSlugIndex(rows);
  const records = await listPushSubscriptions(env);
  if (!records.length) return;

  const changed = new Set();
  for (const { record } of records) {
    const seen = record.seen && typeof record.seen === "object" ? record.seen : {};
    for (const slug of record.slugs || []) {
      const row = bySlug.get(slug);
      if (row === undefined) continue;
      const current = Number(rows[row][9]) || 0;
      const previous = Object.prototype.hasOwnProperty.call(seen, slug)
        ? Number(seen[slug]) || 0
        : current;
      if (current > previous) changed.add(slug);
    }
  }

  const chapters = new Map();
  await pushMapLimit([...changed], 3, async (slug) => {
    try {
      const list = await freshChapterList(slug);
      if (list.length) chapters.set(slug, list[list.length - 1]);
    } catch (err) {
      /* retry this title on the next run */
    }
  });

  for (const { key, record } of records) {
    const seen = record.seen && typeof record.seen === "object" ? record.seen : {};
    let dirty = false;
    let gone = false;
    for (const slug of record.slugs || []) {
      const row = bySlug.get(slug);
      if (row === undefined) continue;
      const current = Number(rows[row][9]) || 0;
      const previous = Object.prototype.hasOwnProperty.call(seen, slug)
        ? Number(seen[slug]) || 0
        : current;
      if (!Object.prototype.hasOwnProperty.call(seen, slug) || current < previous) {
        seen[slug] = current;
        dirty = true;
        continue;
      }
      if (current <= previous) continue;
      const newest = chapters.get(slug);
      if (!newest) continue;                 /* unknown chapter token: retry next run */
      const title = rows[row][1] || slug;
      const label = newest.l || newest.n;
      const url = "/reader/" + encodeURIComponent(slug) +
        (String(newest.n) === "1" ? "" : "/" + encodeURIComponent(newest.n));
      const payload = JSON.stringify({
        title: title + " — new chapter",
        body: "Chapter " + label + " is out",
        url,
        tag: "chapter-" + slug,
        icon: rows[row][3] || "/icon-192.png",
        slug,
        chapter: String(newest.n),
      });
      try {
        const response = await pushSend(vapid, record.subscription, payload);
        try { await response.body?.cancel(); } catch (err) { /* already consumed */ }
        if (response.status === 404 || response.status === 410) {
          await env.BUCKET.delete(key);
          gone = true;
          break;
        }
        if (response.ok) {
          seen[slug] = current;
          dirty = true;
        }
      } catch (err) {
        /* leave the chapter unseen so the next run retries it */
      }
    }
    if (!gone && dirty) {
      record.seen = seen;
      record.updatedAt = Date.now();
      try {
        await env.BUCKET.put(key, JSON.stringify(record), {
          httpMetadata: { contentType: "application/json" },
        });
      } catch (err) {
        /* a lost count is retried from the old one next run */
      }
    }
  }
  console.log("push: checked " + records.length + " subscription(s), " + changed.size + " updated title(s)");
}

export default {
  async scheduled(controller, env, ctx) {
    await sweepData(env);
    await notifyChapterUpdates(env, ctx);
  },

  async fetch(request, env, ctx) {
    /* one check per request: data a refresh uploaded since the last window is
       picked up here, rather than whenever a day-long cache happened to expire */
    await sweepData(env);
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    /* limit before touching R2: the key is the caller's address, which
       Cloudflare sets and a client cannot spoof */
    if (path.startsWith("/api/") || path.startsWith("/reader/") || path.startsWith("/img/")) {
      const isImage = path.startsWith("/img/");
      const isCover = path.startsWith("/api/cover/") || path.startsWith("/api/dexcover/") ||
        path.startsWith("/api/info/");
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      if (await overLimit(env, ctx, isImage ? "image" : isCover ? "cover" : "page", ip)) return tooMany();
    }

    if (path === "/api/push/key") {
      return request.method === "GET" ? pushKeyResponse(env) : json(405, { error: "GET only" });
    }
    if (path === "/api/push/subscribe") {
      return request.method === "POST"
        ? pushSubscribeResponse(env, ctx, request)
        : json(405, { error: "POST only" });
    }
    if (path === "/api/push/unsubscribe") {
      return request.method === "POST"
        ? pushUnsubscribeResponse(env, request)
        : json(405, { error: "POST only" });
    }

    if (path === "/api/ping") {
      if (request.method !== "POST") return json(405, { error: "POST only" });
      return recordVisit(env, request);
    }

    if (path === "/stats" || path === "/stats/") return statsPage(env);

    if (path.startsWith("/img/")) return imageProxyResponse(env, ctx, url);

    if (path.startsWith("/reader/harvest/")) return harvestReaderResponse(env, ctx, url);
    if (path.startsWith("/api/reader/harvest/")) return harvestReaderApi(env, ctx, url);
    if (path.startsWith("/reader/series/")) return mangaggReaderResponse(env, ctx, url);
    if (path.startsWith("/api/reader/series/")) return mangaggReaderApi(env, ctx, url);
    if (path.startsWith("/reader/")) return readerResponse(env, ctx, url);

    if (path === "/sitemap.xml" || /^\/sitemap-[0-9]+\.xml$/.test(path)) {
      try {
        const bytes = await cachedBytes(env, ctx, "sitemap/" + path.slice(1));
        return new Response(bytes, {
          headers: {
            "Content-Type": "application/xml; charset=utf-8",
            "Cache-Control": "public, max-age=3600",
          },
        });
      } catch (err) {
        return new Response("", { status: 404, headers: { "Content-Type": "text/plain" } });
      }
    }

    if (path.startsWith("/t/")) return titlePageResponse(env, ctx, url);

    /* one feed across catalogues: "newest" and "top rated" are not one shelf's
       question, and the discover page is the only place that asks it */
    if (path === "/api/all") return handleMerged(env, ctx, url);

    if (path.startsWith("/api/fresh")) return handleFresh(env, ctx, url);

    if (path.startsWith("/api/story/")) return storyApiResponse(env, ctx, url);

    if (path.startsWith("/api/about/")) return aboutResponse(env, ctx, url);

    if (path.startsWith("/api/reader/")) return readerApiResponse(env, ctx, url);
    if (path.startsWith("/api/reader_data/")) return readerStoryJson(env, ctx, url);

    if (path.startsWith("/api/series")) return handlePage(env, ctx, SHELVES.series, url);
    if (path.startsWith("/api/catalog")) return handlePage(env, ctx, null, url);
    if (path.startsWith("/api/mangadex")) return handlePage(env, ctx, SHELVES.mangadex, url);
    if (path.startsWith("/api/mangaupdates")) return handlePage(env, ctx, SHELVES.mangaupdates, url);

    if (path.startsWith("/api/info/")) return infoResponse(env, ctx, url);

    if (path.startsWith("/api/dexcover/") || path.startsWith("/api/cover/")) {
      const isDex = path.startsWith("/api/dexcover/");
      const ident = decodeURIComponent(path.slice(isDex ? "/api/dexcover/".length : "/api/cover/".length)).replace(/^\/+|\/+$/g, "");
      if (!SLUG_RE.test(ident)) return json(400, { error: "bad slug" });
      const spec = isDex ? SHELVES.mangadex : SHELVES.series;
      /* ?size=large is for the og:image on a title page: a 256px thumbnail is
         under what a link preview wants, and it costs nothing to cache the two
         sizes apart */
      const large = isDex && url.searchParams.get("size") === "large";
      /* dex2: covers cached while the host was challenging the proxy were
         full-size originals (or misses); the new key keeps those out of the way
         rather than serving a 4 MB poster where a thumbnail belongs */
      const key = (isDex ? "dex2/" : "lib/") + ident + (large ? "@2x" : "");
      const direct = await cachedCover(env, ctx, key, "", null, []);
      if (direct) return direct;
      try {
        const target = await coverUrlFor(env, ctx, spec, ident);
        if (!target) return new Response("", { status: 404, headers: { "Cache-Control": "no-store" } });
        const response = await cachedCover(
          env, ctx, key, target,
          isDex ? DEX_COVER_HEADERS : COVER_HEADERS,
          isDex ? (large ? [".512.jpg", ".256.jpg", ""] : DEX_COVER_VARIANTS) : [""]
        );
        if (response) return response;
      } catch (err) {
        /* fall through to a miss */
      }
      return new Response("", { status: 404, headers: { "Cache-Control": "no-store" } });
    }

    return env.ASSETS.fetch(request);
  },
};
