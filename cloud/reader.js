/**
 * The reader page and the chapter parser behind it.
 *
 * mgeko's reader pages are server-rendered: every page of a chapter is an
 * <img class="mgr-page" src="https://imgsrvN.com/..."> in document order, with
 * no API and no lazy-loading attribute to chase.  That makes one GET per title
 * enough to learn the whole chapter, and it means the page can be built here as
 * a single self-contained document: the images are served by mgeko's image CDN,
 * which allows hotlinking, so this Worker never copies or streams them.
 *
 * The reader is deliberately plain: one column, lazy images, a fitted width that
 * can be stepped up to 320%, a floating title bar, a bottom bar with the chapter
 * picker, exact-position history, and pull-to-next at the end of a chapter.  It
 * depends on no script or stylesheet beyond this document.
 */

const IMG_TAG = /<img\b[^>]*>/gi;
const PAGE_CLASS = /\bmgr-page\b/;

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decode(text) {
  return String(text || "").replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (whole, name) => {
    if (name[0] === "#") {
      const code = name[1].toLowerCase() === "x" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] != null ? ENTITIES[name.toLowerCase()] : whole;
  });
}

/** One attribute out of a tag, in any quoting style and any order. */
function attr(tag, name) {
  const match = new RegExp("(?:^|\\s)" + name + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))", "i").exec(tag);
  if (!match) return "";
  return match[1] != null ? match[1] : match[2] != null ? match[2] : match[3] || "";
}

function prettySlug(slug) {
  return String(slug || "")
    .split("-")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/* mgeko repeats its cover as a meta image; keep it beside the reading position
   so the shelves can show the title without a second catalogue lookup. */
function pageCover(html) {
  const tags = html.match(/<meta\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const key = (attr(tag, "property") || attr(tag, "name") || "").toLowerCase();
    if (key !== "og:image" && key !== "twitter:image") continue;
    let src = decode(attr(tag, "content")).trim();
    if (src.indexOf("//") === 0) src = "https:" + src;
    if (/^https?:\/\//i.test(src)) return src;
  }
  return "";
}

export function chapterFromUrl(url) {
  const match = /-chapter-(.+?)-eng-li\/?$/i.exec(String(url || ""));
  if (match) return decode(match[1]).trim();
  const loose = /chapter-([0-9]+(?:\.[0-9]+)?)/i.exec(String(url || ""));
  return loose ? loose[1] : "1";
}

/**
 * mgeko repeats the chapter list in two <select>s (top and bottom) and leaves
 * the current chapter's option with no value.  The raw URL token is what keeps
 * odd chapters addressable -- "200-5" is chapter 200.5, side stories carry
 * words -- so the token, not the number, is the key everywhere.
 */
function optionToken(tag) {
  const value = attr(tag, "value");
  if (!value) return "";
  const match = /-chapter-(.+?)-eng-li\/?$/i.exec(value);
  return match ? decode(match[1]).trim() : "";
}

function optionLabel(option, token) {
  const inner = option.slice(option.indexOf(">") + 1);
  let label = decode(inner.split("<")[0] || "").replace(/\s+/g, " ").trim();
  label = label.replace(/^chapter\s*[:\-]?\s*/i, "").replace(/-eng-li$/i, "").trim();
  if (label) return label;
  return /^[0-9]+-[0-9]+$/.test(token) ? token.replace("-", ".") : token;
}

function parseChapters(html) {
  const select = /<select\b[^>]*id="chapter-select-top"[^>]*>([\s\S]*?)<\/select>/i.exec(html);
  const scope = select ? select[1] : html;
  const seen = new Set();
  const out = [];
  scope.split(/<option\b/i).slice(1).forEach((part) => {
    const end = part.indexOf(">");
    if (end < 0) return;
    const token = optionToken(part.slice(0, end));
    if (!token || seen.has(token)) return;
    /* the select also lists site notices as if they were chapters */
    if (/^(?:announcement|spoiler|notice|news|credits?)$/i.test(token)) return;
    seen.add(token);
    out.push({ n: token, l: optionLabel(part, token) });
  });
  return out;
}

function chapterRank(token) {
  const match = /^([0-9]+)(?:[.-]([0-9]+))?/.exec(String(token));
  if (!match) return [Infinity, 0];
  return [Number(match[1]), match[2] ? Number("0." + match[2]) : 0];
}

function withCurrent(chapters, chapter) {
  const out = chapters.slice();
  if (chapter && !out.some((item) => item.n === chapter)) {
    out.push({ n: chapter, l: /^[0-9]+-[0-9]+$/.test(chapter) ? chapter.replace("-", ".") : chapter });
  }
  if (!out.some((item) => item.n === "1")) out.push({ n: "1", l: "1" });
  out.sort((a, b) => {
    const ra = chapterRank(a.n);
    const rb = chapterRank(b.n);
    /* named extras (side-story-1, prologue) sort after numbered chapters, with
       the name breaking ties so the order is stable on every page */
    const va = Number.isFinite(ra[0]) ? ra[0] + ra[1] : 1e9;
    const vb = Number.isFinite(rb[0]) ? rb[0] + rb[1] : 1e9;
    if (va !== vb) return va - vb;
    return String(a.n).localeCompare(String(b.n));
  });
  return out;
}

/**
 * Pull the ordered image list and a display title out of one reader page.
 *
 * Several hosts appear in the list (/sv2/comic/..., /mg1/fastcdn/...), and a
 * chapter may mix them, so only the host shape is filtered -- anything that is
 * not mgeko's image CDN is an ad or a recommendation card, not a page.
 */
export function parseChapter(html, slug, chapterHint) {
  const images = [];
  const seen = new Set();
  let tag;
  IMG_TAG.lastIndex = 0;
  while ((tag = IMG_TAG.exec(html))) {
    if (!PAGE_CLASS.test(attr(tag, "class"))) continue;
    let src = attr(tag, "src") || attr(tag, "data-src") || attr(tag, "data-lazy-src");
    if (!src) continue;
    src = decode(src).trim();
    if (src.indexOf("//") === 0) src = "https:" + src;
    if (!/^https?:\/\//i.test(src)) continue;
    let host = "";
    try {
      host = new URL(src).hostname.toLowerCase();
    } catch (err) {
      continue;
    }
    if (!/(^|\.)imgsrv[0-9]+\.com$/.test(host) && !/(^|\.)mgsrv[0-9]+\.com$/.test(host)) continue;
    if (seen.has(src)) continue;
    seen.add(src);
    images.push(src);
  }

  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  let title = titleTag ? decode(titleTag[1]).replace(/\s+/g, " ").trim() : "";
  title = title.replace(/^\s*(?:manga|read)\s*:\s*/i, "");
  title = title.split(/\s+chapter\s*[-–:]?\s*[0-9]/i)[0].trim();
  if (!title) title = prettySlug(slug);

  let chapter = String(chapterHint || "");
  if (!chapter) {
    const match = /chapter\s*[-–:]?\s*([0-9]+(?:\.[0-9]+)?)/i.exec(titleTag ? decode(titleTag[1]) : "") ||
      /chapter-([0-9]+(?:\.[0-9]+)?)/i.exec(html);
    chapter = match ? match[1] : "1";
  }

  const chapters = withCurrent(parseChapters(html), chapter);
  return { title, chapter, images, chapters, cover: pageCover(html) };
}

export function esc(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

const STYLE = `*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;background:#07090c}
body{margin:0;background:#07090c;color:#e7eef7;font:14px/1.5 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;overscroll-behavior-y:contain}
a{color:#7dd3fc}
::selection{background:rgba(56,189,248,.3)}
#bar{position:fixed;top:calc(8px + env(safe-area-inset-top));left:8px;right:8px;z-index:30;display:flex;align-items:center;gap:12px;
  padding:10px 12px 10px 16px;border-radius:18px;background:rgba(0,0,0,.93);border:0;
  box-shadow:0 14px 38px rgba(0,0,0,.6);-webkit-backdrop-filter:blur(16px) saturate(1.2);backdrop-filter:blur(16px) saturate(1.2);
  transition:transform .26s cubic-bezier(.22,.8,.3,1),opacity .2s ease}
#bar .who{min-width:0;flex:1;line-height:1.2}
#bar .who b{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;
  font-size:17.5px;font-weight:750;line-height:1.16;letter-spacing:-.01em;white-space:normal;overflow-wrap:anywhere}
#bar .meta{display:flex;align-items:center;gap:6px;margin-top:3px;font-size:11.5px;letter-spacing:.01em;
  color:#a8b6c5;font-variant-numeric:tabular-nums}
#bar .meta i{opacity:.45;font-style:normal}
#bar .meta b{color:#fff;font-weight:650}
#bar .close{flex:none;display:grid;place-items:center;width:34px;height:34px;border-radius:50%;
  color:#fff;text-decoration:none;-webkit-tap-highlight-color:transparent}
#bar .close:hover{background:rgba(255,255,255,.1)}
#bar .close:active{background:rgba(255,255,255,.18)}
#bar .close svg{width:19px;height:19px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round}
#prog{position:fixed;top:0;left:0;height:2px;width:0;z-index:31;background:#38bdf8;transition:width .16s linear,opacity .2s ease;
  box-shadow:0 0 10px rgba(56,189,248,.7)}
main{padding-top:calc(var(--bar-h, 64px) + 24px + env(safe-area-inset-top));padding-bottom:calc(86px + env(safe-area-inset-bottom))}
#pages{--zoom:1;overflow:visible;scrollbar-width:none}
#pages.zoomed{overflow-x:auto;overflow-y:hidden;-webkit-overflow-scrolling:touch}
#pages::-webkit-scrollbar{height:0}
figure{margin:0 auto;width:calc(var(--zoom) * 100%);min-width:100%;background:#0b0e13}
figure+figure{margin-top:2px}
figure img{display:block;width:100%;height:auto;background:#0b0e13}
.end{margin:0 auto;max-width:560px;padding:26px 20px 30px;text-align:center;color:#8b9bb0}
.end p{margin:0 0 14px;font-size:11px;letter-spacing:.18em;text-transform:uppercase}
.end .links{display:flex;gap:8px;justify-content:center;flex-wrap:wrap}
.end a{display:inline-block;padding:10px 16px;border-radius:999px;border:1px solid rgba(148,163,184,.26);color:#dbe7f3;text-decoration:none;font-size:12.5px}
.end a:hover{border-color:rgba(56,189,248,.6);background:rgba(56,189,248,.1)}
.end a.key{border-color:rgba(56,189,248,.5);color:#7dd3fc}
.end .pull-hint{margin:18px 0 0;font-size:10.5px;letter-spacing:.14em;color:#6f8296}
.end .pull-hint b{color:#9fb2c6;font-weight:600}
.end .pull-hint[hidden]{display:none}
#resume{position:fixed;left:50%;top:calc(var(--bar-h, 64px) + 74px + env(safe-area-inset-top));transform:translateX(-50%);z-index:32;
  display:flex;align-items:center;gap:7px;padding:9px 15px;border:1px solid rgba(56,189,248,.45);border-radius:999px;
  background:rgba(11,16,23,.94);color:#d9ecfa;font:600 12.5px/1 inherit;cursor:pointer;box-shadow:0 10px 30px rgba(0,0,0,.5);
  -webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);transition:opacity .2s ease}
#resume[hidden]{display:none}
#resume b{color:#7dd3fc}
#nav{position:fixed;left:8px;right:8px;bottom:calc(8px + env(safe-area-inset-bottom));z-index:34;display:flex;align-items:center;gap:5px;
  padding:7px;border-radius:20px;background:rgba(0,0,0,.93);border:0;
  box-shadow:0 16px 40px rgba(0,0,0,.6);-webkit-backdrop-filter:blur(16px) saturate(1.2);backdrop-filter:blur(16px) saturate(1.2);
  transition:transform .26s cubic-bezier(.22,.8,.3,1),opacity .2s ease}
#nav .icon{flex:none;display:grid;place-items:center;width:44px;height:44px;border:0;border-radius:14px;
  background:rgba(255,255,255,.08);color:#f2f7fb;text-decoration:none;cursor:pointer;font:650 12px/1 inherit;
  -webkit-tap-highlight-color:transparent}
#nav .icon:hover{background:rgba(148,163,184,.16)}
#nav .icon:active{background:rgba(56,189,248,.22)}
#nav .icon svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
#nav .icon[hidden]{display:none}
#nav .prev{color:#fff}
#nav .next{color:#7dd3fc}
#nav .pick{position:relative;flex:1;min-width:0}
#nav select{-webkit-appearance:none;appearance:none;display:block;width:100%;height:44px;padding:0 30px 0 12px;border:0;border-radius:14px;
  background:rgba(255,255,255,.08);color:#f2f7fb;cursor:pointer;
  font:600 12.5px/1.3 ui-sans-serif,system-ui,-apple-system,sans-serif;letter-spacing:.02em;
  text-overflow:ellipsis;white-space:nowrap;overflow:hidden}
#nav .pick::after{content:"";position:absolute;right:11px;top:50%;width:6px;height:6px;pointer-events:none;
  border-right:1.5px solid #93a7bb;border-bottom:1.5px solid #93a7bb;transform:translateY(-70%) rotate(45deg)}
#zoom{position:fixed;left:50%;bottom:calc(68px + env(safe-area-inset-bottom));transform:translateX(-50%);z-index:33;
  display:flex;align-items:center;gap:2px;padding:4px;border-radius:999px;border:1px solid rgba(148,163,184,.22);
  background:rgba(13,19,27,.92);box-shadow:0 12px 34px rgba(0,0,0,.55);-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);
  transition:opacity .2s ease}
#zoom[hidden]{display:none}
#zoom button{min-width:44px;height:40px;border:0;border-radius:999px;background:transparent;color:#dbe7f3;
  font:650 13px/1 inherit;cursor:pointer;display:grid;place-items:center}
#zoom button:hover{background:rgba(148,163,184,.14)}
#zoom button:active{background:rgba(56,189,248,.24)}
#zoom #zoomPct{min-width:64px;font-size:12px;color:#8fb6cf;font-variant-numeric:tabular-nums;font-weight:600}
#zoom #fit{font-size:11.5px;letter-spacing:.04em;color:#a9c2d6}
#infoBtn{position:fixed;left:8px;top:calc(var(--bar-h, 64px) + 26px + env(safe-area-inset-top));z-index:32;
  display:grid;place-items:center;width:36px;height:36px;border:0;border-radius:50%;
  background:#000;color:#fff;font:italic 700 18px/1 Georgia,serif;cursor:pointer;text-decoration:none;
  box-shadow:0 10px 26px rgba(0,0,0,.55);transition:opacity .2s ease,transform .2s ease;
  -webkit-tap-highlight-color:transparent}
#infoBtn:hover{background:#161b22}
#infoBtn:active{background:#252b33;transform:scale(.96)}
/* the "i" sheet is the cover page in miniature: full cover, status, synopsis,
   genres and the same chapter order control, dragged down to dismiss */
#story{position:fixed;inset:0;z-index:70;background:rgba(3,5,8,.72);
  -webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px)}
#story[hidden]{display:none}
.story-veil{position:absolute;inset:0}
.story-card{position:absolute;inset:0;overflow-y:auto;overscroll-behavior:contain;background:#000;color:#fff;
  -webkit-overflow-scrolling:touch;will-change:transform;transition:transform .26s cubic-bezier(.22,.8,.3,1)}
.story-hero{position:relative;height:min(60vh,500px);overflow:hidden;background:#141414;isolation:isolate}
.story-hero-img{position:absolute;inset:0;display:block;width:100%;height:100%;object-fit:cover}
.story-hero-img[hidden]{display:none}
.story-hero::after{content:"";position:absolute;inset:0;z-index:1;
  background:linear-gradient(180deg,rgba(0,0,0,.52) 0%,rgba(0,0,0,.06) 30%,rgba(0,0,0,.42) 66%,#000 100%)}
.story-hero-bar{position:absolute;right:8px;top:calc(8px + env(safe-area-inset-top));z-index:3}
.story-x{display:grid;place-items:center;width:38px;height:38px;border:0;border-radius:50%;
  background:rgba(0,0,0,.55);color:#fff;font:400 24px/1 ui-sans-serif,system-ui,sans-serif;cursor:pointer;
  -webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px)}
.story-x:active{background:rgba(255,255,255,.18)}
.story-hero-copy{position:absolute;left:16px;right:16px;bottom:10px;z-index:2}
.story-title{margin:0;color:#fff;font-size:clamp(26px,7.6vw,34px);line-height:1.1;font-weight:800;letter-spacing:-.022em;
  display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.story-wrap{padding:15px 16px calc(40px + env(safe-area-inset-bottom))}
.story-meta-row{display:flex;flex-wrap:wrap;align-items:center;gap:7px 16px;color:#e5e5ea;font-size:13.5px;font-weight:500}
.story-bit{display:inline-flex;align-items:center;gap:6px;white-space:nowrap}
.story-bit[hidden]{display:none}
.story-bit-strong{color:#fff;font-weight:650;font-variant-numeric:tabular-nums}
.story-synopsis{margin:16px 0 0;color:#f2f2f7;font-size:15.5px;line-height:1.62;
  display:-webkit-box;-webkit-line-clamp:6;-webkit-box-orient:vertical;overflow:hidden}
.story-synopsis.is-open{display:block}
.story-synopsis[hidden]{display:none}
.story-more{display:block;margin:1px 0 0 auto;padding:4px 0 4px 14px;border:0;background:transparent;
  color:#d1d1d6;font:inherit;font-size:16px;font-weight:600;cursor:pointer}
.story-more[hidden]{display:none}
.story-genres{display:flex;gap:8px;margin:10px -16px 0;padding:0 16px 4px;overflow-x:auto;scrollbar-width:none}
.story-genres::-webkit-scrollbar{display:none}
.story-genres:empty{display:none}
.story-genres span{flex:none;padding:6px 13px;border:1px solid #3a3a3c;border-radius:999px;
  color:#f2f2f7;font-size:13px;line-height:1.25;white-space:nowrap}
.story-ch-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:24px 0 12px}
.story-ch-title{margin:0;color:#8e8e93;font-size:12px;font-weight:700;letter-spacing:.14em;text-transform:uppercase}
.story-ch-sort{display:inline-flex;gap:2px;padding:3px;border-radius:999px;background:#1c1c1e}
.story-ch-sort button{-webkit-appearance:none;appearance:none;border:0;border-radius:999px;background:transparent;
  color:#a1a1a6;font:600 12px/1 inherit;padding:8px 12px;cursor:pointer;-webkit-tap-highlight-color:transparent}
.story-ch-sort button.on{background:#ff453a;color:#fff}
.story-chapters{display:flex;flex-direction:column;gap:8px;margin:0;padding-left:10px;border-left:3px solid #ff453a}
.story-ch-row{display:flex;align-items:center;justify-content:space-between;gap:14px;width:100%;min-height:56px;
  padding:14px;border:1px solid #1f1f21;border-radius:12px;background:#0d0d0d;color:#fff;text-decoration:none;
  -webkit-tap-highlight-color:transparent;touch-action:manipulation;box-sizing:border-box}
.story-ch-row:active{background:#171719;border-color:#2c2c2e}
.story-ch-row.is-current{box-shadow:inset 3px 0 0 #38bdf8}
.story-ch-label{font-size:17px;font-weight:700;line-height:1.22;letter-spacing:-.012em}
.story-ch-when{flex:none;color:#8e8e93;font-size:13.5px;font-variant-numeric:tabular-nums}
body.story-open{overflow:hidden}
body.story-open{overflow:hidden}
main{transition:transform .34s cubic-bezier(.22,.8,.3,1)}
#pull{position:fixed;left:0;right:0;bottom:0;z-index:20;display:flex;flex-direction:column;align-items:center;
  justify-content:flex-end;height:52vh;padding-bottom:calc(92px + env(safe-area-inset-bottom));pointer-events:none;
  opacity:0;background:linear-gradient(to top,rgba(7,9,12,.97) 0%,rgba(7,9,12,.72) 42%,rgba(7,9,12,0) 100%);
  transition:opacity .28s ease}
#pull .pull-kicker{font-size:10.5px;font-weight:650;letter-spacing:.2em;text-transform:uppercase;color:#7dd3fc;
  margin-bottom:8px;text-align:center}
#pull b{display:block;font-size:clamp(28px,8.4vw,42px);font-weight:800;letter-spacing:-.03em;color:#eaf6ff;
  line-height:1;text-align:center}
#pull.armed b{color:#fff;text-shadow:0 0 26px rgba(56,189,248,.65)}
#pull.prev{top:0;bottom:auto;justify-content:flex-start;padding-top:calc(var(--bar-h, 64px) + 26px + env(safe-area-inset-top));
  background:linear-gradient(to bottom,rgba(7,9,12,.97) 0%,rgba(7,9,12,.72) 42%,rgba(7,9,12,0) 100%)}
#veil{position:fixed;inset:0;z-index:60;display:grid;place-items:center;background:#07090c;color:#dbe7f3;
  transform:translateY(100%);transition:transform .3s cubic-bezier(.22,.8,.3,1);pointer-events:none;
  font:600 11px/1 ui-sans-serif,system-ui,-apple-system,sans-serif;letter-spacing:.18em;text-transform:uppercase}
#veil.on{transform:translateY(0)}
#veil b{color:#7dd3fc;font-weight:700}
body.chrome-off #bar{transform:translateY(calc(-100% - 18px));opacity:0;pointer-events:none}
body.chrome-off #nav{transform:translateY(calc(100% + 18px));opacity:0;pointer-events:none}
body.chrome-off #zoom{opacity:0;pointer-events:none}
body.chrome-off #prog{opacity:0}
body.chrome-off #resume{opacity:0;pointer-events:none}
body.chrome-off #infoBtn{opacity:0;pointer-events:none}
noscript p{margin:24px;color:#8b9bb0}
@media (prefers-reduced-motion:reduce){#bar,#nav,#prog,#pull,#veil,#infoBtn{transition:none}}

.reader-veil{position:fixed;inset:0;z-index:200;display:grid;place-items:center;
  background:rgba(4,6,9,.55);-webkit-backdrop-filter:blur(9px) saturate(.85);backdrop-filter:blur(9px) saturate(.85);
  opacity:0;pointer-events:none;transition:opacity .2s ease-out,background-color .3s ease-out}
.reader-veil.on{opacity:1;pointer-events:auto}
.reader-veil.out{background:#040405}
.reader-veil-text{font-family:"Inter",ui-sans-serif,system-ui,-apple-system,sans-serif;
  font-size:clamp(38px,12vw,88px);font-weight:900;line-height:.92;letter-spacing:-.035em;
  text-transform:uppercase;text-align:center;color:#f4f6f8;
  text-shadow:0 1px 0 rgba(255,255,255,.07),0 3px 0 rgba(0,0,0,.5),0 18px 40px rgba(0,0,0,.45);
  animation:readerVeilIn .45s cubic-bezier(.22,.8,.3,1) both;
  padding:0 16px;max-width:min(92vw,760px)}
.reader-veil.out .reader-veil-text{opacity:0;transition:opacity .22s ease-in}
@keyframes readerVeilIn{from{opacity:0;transform:scale(.97)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){.reader-veil-text{animation:none}}
`;

function pageShell(data) {
  const images = data.images || [];
  const title = esc(data.title || prettySlug(data.slug));
  const chapter = esc(String(data.chapter || "1"));
  const slug = esc(data.slug);
  const count = images.length;
  const chapters = Array.isArray(data.chapters) ? data.chapters : [];
  /* mgeko lives at /reader; a mangagg chapter is addressed under its own
     source prefix so the two slug namespaces can never be confused */
  const base = data.base || "/reader";
  /* the same document serves both catalogues; everything that points back into
     the app has to name the right story page, or a mangagg chapter closes onto
     mgeko's (empty) story path */
  const series = String(base).indexOf("/series") >= 0;
  const siteName = data.site || (series ? "mangagg" : "mgeko");
  const closeHref = data.closeHref || ("#story/" + (series ? "series/" : "") + encodeURIComponent(data.slug));
  const currentChapter = String(data.chapter || "1");
  const currentLabel = (chapters.find((item) => String(item.n) === currentChapter) || {}).l || currentChapter;

  const chapterOptions = (chapters.length ? chapters : [{ n: currentChapter, l: currentChapter }])
    .map((item) => '<option value="' + esc(item.n) + '"' +
      (String(item.n) === currentChapter ? " selected" : "") +
      ">Chapter " + esc(item.l) + "</option>")
    .join("");
  const at = chapters.findIndex((item) => String(item.n) === currentChapter);
  const nextChapter = at >= 0 ? chapters[at + 1] : null;
  const nextHref = nextChapter
    ? base + "/" + encodeURIComponent(data.slug) + "/" + encodeURIComponent(nextChapter.n)
    : "";
  const prevChapter = at > 0 ? chapters[at - 1] : null;
  const prevHref = prevChapter
    ? base + "/" + encodeURIComponent(data.slug) + "/" + encodeURIComponent(prevChapter.n)
    : "";
  const payload = JSON.stringify({
    slug: data.slug,
    base: base,
    api: data.api || "/api/reader",
    chapter: currentChapter,
    label: currentLabel,
    cover: data.cover || "",
    images,
    chapters,
    next: nextHref ? { href: nextHref, l: nextChapter.l, n: nextChapter.n } : null,
    source: data.source || "",
    /* the sheet fills its synopsis, tags and large cover from the same story
       endpoint the cover page uses */
    story: data.story != null ? data.story : (series ? "/api/story/series/" : "/api/story/") + encodeURIComponent(data.slug),
  }).replace(/</g, "\\u003c").replace(/\u2028|\u2029/g, "");

  const figures = images.map((src, index) => {
    const eager = index < 2;
    return '<figure data-i="' + (index + 1) + '"><img src="' + esc(src) + '" alt="Page ' + (index + 1) +
      '" ' + (eager ? 'loading="eager" fetchpriority="' + (index ? "low" : "high") + '"' : 'loading="lazy"') +
      ' decoding="async"></figure>';
  }).join("");

  const storyChapters = chapters.length ? chapters : [{ n: currentChapter, l: currentLabel }];
  const storyMeta = storyChapters.length + " chapter" + (storyChapters.length === 1 ? "" : "s") +
    " · reading chapter " + esc(String(currentLabel));
  const coverSrc = data.cover || "";
  const coverLetter = esc(String(data.title || data.slug || "?").slice(0, 1).toUpperCase());
  const source = esc(data.source || ("https://www.mgeko.cc/manga/" + data.slug + "/"));

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#07090c">
<meta name="robots" content="noindex,nofollow">
<meta name="referrer" content="no-referrer">
<title>${title} · chapter ${chapter} · reader</title>
<style>${STYLE}</style>
</head>
<body data-slug="${slug}" data-count="${count}">
<header id="bar">
  <div class="who">
    <b>${title}</b>
    <div class="meta"><span id="chapText">Ch. ${esc(String(currentLabel))}</span><i>·</i><span><b id="now">1</b>/${count}</span></div>
  </div>
  <a class="close" id="close" href="${closeHref}" aria-label="Close reader" title="Close reader"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></a>
</header>
<a id="infoBtn" href="${closeHref}" aria-label="Story info and chapters" title="Story info and chapters">i</a>
<div id="prog"></div>
<button id="resume" type="button" hidden>resuming page <b></b></button>
<main>
  <div id="pages">${figures}</div>
  <footer class="end">
    <p>end of chapter ${chapter}</p>
    <div class="links">
      <a class="key" id="next" href="${esc(nextHref)}"${nextHref ? "" : " hidden"}>next chapter →</a>
      <a href="${source}" target="_blank" rel="noopener noreferrer">${siteName} page</a>
      <a href="/">back to shelves</a>
    </div>
    <p class="pull-hint" id="pullHint"${nextHref ? "" : " hidden"}>or pull up for chapter <b>${nextChapter ? esc(nextChapter.l) : ""}</b></p>
  </footer>
</main>
<div id="pull" aria-hidden="true"><span class="pull-kicker" id="pullKicker">next chapter</span><b id="pullText"></b></div>
<nav id="nav" aria-label="Reader navigation">
  <a class="icon prev" id="prevIcon" href="${esc(prevHref)}" aria-label="Previous chapter"${prevHref ? "" : " hidden"}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg></a>
  <div class="pick"><select id="chap" aria-label="Chapter">${chapterOptions}</select></div>
  <button class="icon" id="zoomBtn" type="button" aria-label="Page size" aria-expanded="false">Aa</button>
  <a class="icon next" id="nextIcon" href="${esc(nextHref)}" aria-label="Next chapter"${nextHref ? "" : " hidden"}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg></a>
</nav>
<div id="zoom" role="group" aria-label="Page size" hidden>
  <button type="button" data-z="-" aria-label="Zoom out">−</button>
  <button type="button" id="fit" data-z="fit" aria-label="Fit width">fit</button>
  <button type="button" data-z="+" aria-label="Zoom in">+</button>
  <span id="zoomPct">100%</span>
</div>
<div id="story" hidden>
  <div class="story-veil" data-story-close></div>
  <section class="story-card" role="dialog" aria-modal="true" aria-labelledby="storyTitle">
    <div class="story-hero">
      <img class="story-hero-img" id="storyCover"${coverSrc ? ' src="' + esc(coverSrc) + '"' : ""} alt=""${coverSrc ? "" : " hidden"}>
      <div class="story-hero-bar">
        <button class="story-x" id="storyClose" type="button" aria-label="Close story info">×</button>
      </div>
      <div class="story-hero-copy"><h1 class="story-title" id="storyTitle">${title}</h1></div>
    </div>
    <div class="story-wrap">
      <div class="story-meta-row">
        <span class="story-bit"><span class="story-bit-strong" id="storyChaptersBit">${storyChapters.length}</span> chapters</span>
        <span class="story-bit" id="storyStatusBit" hidden></span>
        <span class="story-bit" id="storyYearBit" hidden></span>
      </div>
      <p class="story-synopsis" id="storySyn" hidden></p>
      <button class="story-more" id="storyMore" type="button" hidden>More</button>
      <div class="story-genres" id="storyGenres"></div>
      <div class="story-ch-head">
        <h2 class="story-ch-title" id="storyCount">${storyChapters.length} chapters</h2>
        <div class="story-ch-sort" id="storySort" role="group" aria-label="Chapter order">
          <button type="button" data-order="desc" class="on" aria-pressed="true">Latest</button>
          <button type="button" data-order="asc" aria-pressed="false">1 → ${storyChapters.length}</button>
        </div>
      </div>
      <div class="story-chapters" id="storyList"></div>
    </div>
  </section>
</div>
<div id="veil" aria-hidden="true">chapter <b id="veilLabel"></b></div>
<noscript><p>the reader needs javascript; <a href="${source}">open the chapter on ${siteName}</a>.</p></noscript>
<script>
(function () {
  var DATA = ${payload};
  var pages = document.getElementById("pages");
  var figs = Array.prototype.slice.call(pages.querySelectorAll("figure"));
  if (!figs.length) return;

  var body = document.body;
  var nowEl = document.getElementById("now");
  var chapText = document.getElementById("chapText");
  var pctEl = document.getElementById("zoomPct");
  var prog = document.getElementById("prog");
  var resumeEl = document.getElementById("resume");
  var chapEl = document.getElementById("chap");
  var nextEl = document.getElementById("next");
  var nextIcon = document.getElementById("nextIcon");
  var zoomEl = document.getElementById("zoom");
  var zoomBtn = document.getElementById("zoomBtn");
  var pullEl = document.getElementById("pull");
  var pullText = document.getElementById("pullText");
  var pullKicker = document.getElementById("pullKicker");
  var mainEl = document.querySelector("main");
  var pullHint = document.getElementById("pullHint");
  var veil = document.getElementById("veil");
  var veilLabel = document.getElementById("veilLabel");
  var barEl = document.getElementById("bar");
  var infoBtn = document.getElementById("infoBtn");
  var prevIcon = document.getElementById("prevIcon");

  var STEPS = [1, 1.35, 1.8, 2.4, 3.2];
  var zi = 0;
  var current = 0;
  var key = "reader:" + DATA.slug + (String(DATA.chapter) === "1" ? "" : ":" + DATA.chapter);
  var saveTimer = 0;
  var resumeTimer = 0;
  var preloaded = {};
  var chapWired = false;
  var chapterList = DATA.chapters && DATA.chapters.length ? DATA.chapters : null;
  var nextHref = DATA.next && DATA.next.href ? DATA.next.href : "";
  var nextLabel = DATA.next && DATA.next.l ? DATA.next.l : "";
  var nextToken = DATA.next && DATA.next.n ? String(DATA.next.n) : "";
  var prevHref = "";
  var prevLabel = "";
  var warmedHref = "";
  var warmImages = [];
  var restoring = false;
  var cancelRestore = null;
  var seenScroll = false;
  var leaving = false;

  function fitChrome() {
    if (!barEl) return;
    document.documentElement.style.setProperty("--bar-h", barEl.offsetHeight + "px");
  }
  fitChrome();
  requestAnimationFrame(fitChrome);
  window.addEventListener("resize", fitChrome);
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(fitChrome).catch(function () {});
  }

  /* The rounded "i" opens the cover page as a sheet: the same full cover,
     status, synopsis, genres and chapter order, painted from what the chapter
     already knew and filled from the story endpoint when it opens.  Drag it
     down to dismiss; the X, the backdrop and Escape close it too. */
  var storyEl = document.getElementById("story");
  var storyClose = document.getElementById("storyClose");
  var sheet = storyEl ? storyEl.querySelector(".story-card") : null;
  var storyListEl = document.getElementById("storyList");
  var storySortEl = document.getElementById("storySort");
  var storyNextEl = document.getElementById("storyNext");
  var storyCoverImg = document.getElementById("storyCover");
  var storyTitleEl = document.getElementById("storyTitle");
  var storySynEl = document.getElementById("storySyn");
  var storyMoreBtn = document.getElementById("storyMore");
  var storyGenresEl = document.getElementById("storyGenres");
  var storyCountEl = document.getElementById("storyCount");
  var storyChaptersBit = document.getElementById("storyChaptersBit");
  var storyStatusBit = document.getElementById("storyStatusBit");
  var storyYearBit = document.getElementById("storyYearBit");
  var storyOrder = "desc";
  var storyEnriched = false;
  var storyOpener = null;

  /* The sheet is the cover page, not a shortened version of it: the same hero,
     title, status row, synopsis, tags and boxed chapter list, opened over the
     chapter and dragged down to dismiss. */
  function renderStoryRows() {
    if (!storyListEl) return;
    var list = DATA.chapters && DATA.chapters.length ? DATA.chapters : [{ n: DATA.chapter, l: DATA.label }];
    if (storyCountEl) storyCountEl.textContent = list.length + " chapters";
    var frag = document.createDocumentFragment();
    for (var step = 0; step < list.length; step += 1) {
      var item = list[storyOrder === "asc" ? step : list.length - 1 - step];
      var active = String(item.n) === String(DATA.chapter);
      var row = document.createElement("a");
      row.className = "story-ch-row" + (active ? " is-current" : "");
      row.href = chapterUrl(item.n);
      var label = document.createElement("span");
      label.className = "story-ch-label";
      var value = String(item.l || item.n);
      label.textContent = /^[0-9]/.test(value) ? "Ch. " + value + " - Chapter " + value : "Ch. " + value;
      var when = document.createElement("span");
      when.className = "story-ch-when";
      when.textContent = active ? "reading now" : "";
      row.appendChild(label);
      row.appendChild(when);
      frag.appendChild(row);
    }
    storyListEl.replaceChildren(frag);
  }

  function openStory() {
    if (!storyEl) return;
    storyOpener = document.activeElement;
    if (sheet) {
      sheet.style.transition = "";
      sheet.style.transform = "";
      sheet.style.opacity = "";
      sheet.scrollTop = 0;
    }
    storyEl.style.background = "";
    storyEl.hidden = false;
    document.body.classList.add("story-open");
    if (storyClose) storyClose.focus({ preventScroll: true });
    enrichStory();
  }

  function closeStory() {
    if (!storyEl || storyEl.hidden) return;
    if (sheet) {
      sheet.style.transition = "";
      sheet.style.transform = "";
      sheet.style.opacity = "";
    }
    storyEl.style.background = "";
    storyEl.hidden = true;
    document.body.classList.remove("story-open");
    if (storyOpener && storyOpener.focus) storyOpener.focus({ preventScroll: true });
    storyOpener = null;
  }

  function enrichStory() {
    if (storyEnriched || !DATA.story) return;
    storyEnriched = true;
    fetch(DATA.story)
      .then(function (response) { return response.ok ? response.json() : null; })
      .then(function (book) {
        if (!book || !book.slug) return;
        if (book.title && storyTitleEl) storyTitleEl.textContent = book.title;
        if (book.cover && storyCoverImg) {
          storyCoverImg.src = book.cover;
          storyCoverImg.hidden = false;
        }
        if (book.chapters && storyChaptersBit) storyChaptersBit.textContent = String(book.chapters);
        if (book.status && storyStatusBit) {
          storyStatusBit.textContent = book.status;
          storyStatusBit.hidden = false;
        }
        if (book.year && storyYearBit) {
          storyYearBit.textContent = book.year;
          storyYearBit.hidden = false;
        }
        var synopsis = book.description || book.teaser || "";
        if (synopsis && storySynEl) {
          storySynEl.textContent = synopsis;
          storySynEl.hidden = false;
          if (storyMoreBtn) storyMoreBtn.hidden = synopsis.length < 240;
        }
        if (Array.isArray(book.genres) && book.genres.length && storyGenresEl) {
          storyGenresEl.textContent = "";
          book.genres.slice(0, 12).forEach(function (genre) {
            var chip = document.createElement("span");
            chip.textContent = genre;
            storyGenresEl.appendChild(chip);
          });
        }
      })
      .catch(function () { /* the sheet still has what the chapter knew */ });
  }

  if (infoBtn) {
    infoBtn.addEventListener("click", function (event) {
      if (!storyEl) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      openStory();
    });
  }
  if (storyClose) storyClose.addEventListener("click", closeStory);
  Array.prototype.forEach.call(document.querySelectorAll("[data-story-close]"), function (node) {
    node.addEventListener("click", closeStory);
  });
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && storyEl && !storyEl.hidden) closeStory();
  });
  if (storyCoverImg) {
    storyCoverImg.addEventListener("error", function () { storyCoverImg.hidden = true; });
  }
  if (storyMoreBtn) {
    storyMoreBtn.addEventListener("click", function () {
      if (!storySynEl) return;
      var open = storySynEl.classList.toggle("is-open");
      storyMoreBtn.textContent = open ? "Less" : "More";
    });
  }
  if (storySortEl) {
    storySortEl.addEventListener("click", function (event) {
      var button = event.target.closest ? event.target.closest("button") : null;
      if (!button) return;
      var order = button.getAttribute("data-order");
      if (!order || order === storyOrder) return;
      storyOrder = order;
      Array.prototype.forEach.call(storySortEl.querySelectorAll("button"), function (node) {
        var on = node.getAttribute("data-order") === storyOrder;
        node.classList.toggle("on", on);
        node.setAttribute("aria-pressed", String(on));
      });
      renderStoryRows();
    });
  }

  /* Drag the sheet down from the hero to put it away; past a third of a screen
     it closes, otherwise it springs back.  In the chapter list it is scrolling. */
  var sheetStartY = 0;
  var sheetPull = 0;
  var sheetDragging = false;
  var sheetClosing = false;
  if (storyEl && sheet) {
    storyEl.addEventListener("touchstart", function (event) {
      if (event.touches.length !== 1 || sheetClosing || sheet.scrollTop > 0) return;
      sheetDragging = true;
      sheetStartY = event.touches[0].clientY;
      sheetPull = 0;
      sheet.style.transition = "none";
    }, { passive: true });
    storyEl.addEventListener("touchmove", function (event) {
      if (!sheetDragging) return;
      var dy = event.touches[0].clientY - sheetStartY;
      if (dy <= 0 || sheet.scrollTop > 0) {
        sheetDragging = false;
        sheetPull = 0;
        sheet.style.transition = "";
        sheet.style.transform = "";
        sheet.style.opacity = "";
        return;
      }
      if (event.cancelable) event.preventDefault();
      sheetPull = dy;
      sheet.style.transform = "translateY(" + dy + "px)";
      sheet.style.opacity = String(Math.max(0.35, 1 - dy / 900));
    }, { passive: false });
    storyEl.addEventListener("touchend", function () {
      if (!sheetDragging) return;
      sheetDragging = false;
      sheet.style.transition = "";
      if (sheetPull > 96) {
        sheetClosing = true;
        sheet.style.transform = "translateY(110%)";
        sheet.style.opacity = "0";
        setTimeout(function () {
          closeStory();
          sheetClosing = false;
        }, 180);
      } else {
        sheet.style.transform = "";
        sheet.style.opacity = "";
      }
      sheetPull = 0;
    });
    storyEl.addEventListener("touchcancel", function () {
      sheetDragging = false;
      sheetPull = 0;
      sheet.style.transition = "";
      sheet.style.transform = "";
      sheet.style.opacity = "";
    });
  }

  renderStoryRows();

  var THRESHOLD = 68;
  var pullDist = 0;
  var pullStart = 0;
  var pullActive = false;
  var pullArmed = false;
  var prevPullDist = 0;
  var prevPullStart = 0;
  var prevPullActive = false;
  var prevPullArmed = false;
  var wheelAccum = 0;
  var wheelTimer = 0;

  /* Whichever mechanism restored the browser's own scroll, we own the
     position: it is restored page-exactly below, after the images above it
     have their real heights. */
  try { if ("scrollRestoration" in history) history.scrollRestoration = "manual"; } catch (err) {}

  /* One metadata map for the shelves, rather than repeating a title and cover
     in every chapter's position record. */
  function rememberMeta() {
    try {
      var all = JSON.parse(localStorage.getItem("reader-meta:v1") || "{}");
      if (!all || typeof all !== "object") all = {};
      var previous = all[DATA.slug] && typeof all[DATA.slug] === "object" ? all[DATA.slug] : {};
      all[DATA.slug] = {
        title: DATA.title || previous.title || "",
        cover: DATA.cover || previous.cover || ""
      };
      localStorage.setItem("reader-meta:v1", JSON.stringify(all));
    } catch (err) { /* private mode: history just stays minimal */ }
  }
  rememberMeta();

  function preload(index) {
    var src = DATA.images[index];
    if (!src || preloaded[src]) return;
    preloaded[src] = 1;
    var img = new Image();
    img.decoding = "async";
    img.src = src;
  }

  function preloadAhead(index) {
    for (var step = 1; step <= 2; step += 1) preload(index + step);
  }

  /* Pages are lazy by default, and lazy loading waits for a scroll in some
     engines: a chapter opened on a saved position, or one whose first layout
     happens before any image has a height, can sit on blank paper until the
     reader nudges the screen.  Ask for the pages around the reading position
     here instead, so the request does not depend on that heuristic.  Only
     images the browser has not started yet are touched. */
  /* A long chapter is a long strip of full-size scans, and Safari keeps the
     decoded bitmap of every one it has painted.  Past a few dozen pages that is
     the whole memory budget of an older phone, which is why reading gets heavy
     the deeper the chapter goes.  Pages well behind the reading line are handed
     back to the browser: the loaded size becomes the figure's aspect ratio
     first, so the page keeps its exact height and nothing on screen moves, and
     the src is restored from data-src when the reader scrolls back up. */
  var KEEP_BEHIND = 7;
  var KEEP_AHEAD = 9;

  function dropPage(fig, img) {
    if (!img || img.getAttribute("data-src")) return;
    if (!img.complete || !img.naturalWidth) return;
    var src = img.currentSrc || img.currentSrc || img.src;
    if (!src) return;
    img.setAttribute("data-src", src);
    fig.style.aspectRatio = img.naturalWidth + " / " + img.naturalHeight;
    img.removeAttribute("src");
  }

  function wakeImage(img) {
    var src = img.getAttribute("data-src");
    if (!src) return;
    img.removeAttribute("data-src");
    img.loading = "eager";
    img.src = src;
  }

  function wake() {
    var near = window.innerHeight * 2;
    for (var i = 0; i < figs.length; i += 1) {
      var fig = figs[i];
      var img = fig.querySelector("img");
      if (!img) continue;
      if (i < current - KEEP_BEHIND) {
        dropPage(fig, img);
        continue;
      }
      if (i > current + KEEP_AHEAD) continue;
      if (!img.getAttribute("src") && img.getAttribute("data-src")) {
        wakeImage(img);
        continue;
      }
      if (!img.getAttribute("src") || img.complete || img.currentSrc) continue;
      var ahead = i >= current - 1 && i <= current + 2;
      var tall = fig.offsetHeight > 0;
      var rect = tall ? fig.getBoundingClientRect() : null;
      var visible = rect && rect.bottom > -near && rect.top < near;
      if (!ahead && !visible) continue;
      img.loading = "eager";
      img.src = img.getAttribute("src");
    }
  }

  var wakeQueued = false;
  function queueWake() {
    if (wakeQueued) return;
    wakeQueued = true;
    requestAnimationFrame(function () {
      wakeQueued = false;
      if (!restoring) wake();
    });
  }
  window.addEventListener("pageshow", wake);

  /* The reading line is 45% down the viewport.  Store which page it falls in
     and how far through that page, not a raw offset: that survives a different
     viewport, zoom or image height on the next visit. */
  function spot() {
    var line = window.pageYOffset + window.innerHeight * 0.45;
    var i = 0;
    for (var k = 0; k < figs.length; k += 1) {
      i = k;
      if (line < figs[k].offsetTop + figs[k].offsetHeight) break;
    }
    var fig = figs[i];
    var frac = fig ? (line - fig.offsetTop) / Math.max(1, fig.offsetHeight) : 0;
    /* Where this chapter sits in the title, so the shelves can show progress
       through the whole story rather than only through one chapter. */
    var chapterPosition = 0;
    var chapterTotal = chapterList ? chapterList.length : 0;
    if (chapterList) {
      for (var c = 0; c < chapterList.length; c += 1) {
        if (String(chapterList[c].n) === String(DATA.chapter)) { chapterPosition = c + 1; break; }
      }
    }
    return {
      i: i,
      f: Math.max(0, Math.min(1, frac)),
      t: Date.now(),
      n: figs.length,
      /* the app builds reader links from this record, so it has to know which
         catalogue the chapter belonged to */
      s: DATA.base && DATA.base.indexOf("/series") >= 0 ? 1 : 0,
      l: DATA.label || String(DATA.chapter),
      c: chapterPosition,
      m: chapterTotal
    };
  }

  function save() {
    if (restoring) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      try { localStorage.setItem(key, JSON.stringify(spot())); } catch (err) { /* private mode */ }
    }, 300);
  }

  function flush() {
    if (restoring) return;
    clearTimeout(saveTimer);
    try { localStorage.setItem(key, JSON.stringify(spot())); } catch (err) {}
  }

  function paint() {
    nowEl.textContent = String(current + 1);
    prog.style.width = ((current + 1) / figs.length) * 100 + "%";
    preloadAhead(current);
    wake();
    save();
  }

  function chapterUrl(token) {
    return DATA.base + "/" + encodeURIComponent(DATA.slug) + "/" + encodeURIComponent(token);
  }

  function updateNext() {
    if (!chapterList) return;
    var at = -1;
    for (var i = 0; i < chapterList.length; i += 1) {
      if (String(chapterList[i].n) === String(DATA.chapter)) { at = i; break; }
    }
    var next = at >= 0 ? chapterList[at + 1] : null;
    var prev = at > 0 ? chapterList[at - 1] : null;
    nextHref = next ? chapterUrl(next.n) : "";
    nextLabel = next ? next.l : "";
    nextToken = next ? String(next.n) : "";
    if (nextEl) {
      nextEl.href = nextHref;
      nextEl.hidden = !next;
      if (next) nextEl.textContent = "next · chapter " + next.l + " →";
    }
    if (nextIcon) {
      nextIcon.href = nextHref;
      nextIcon.hidden = !next;
    }
    prevHref = prev ? chapterUrl(prev.n) : "";
    prevLabel = prev ? prev.l : "";
    if (prevIcon) {
      prevIcon.href = prevHref;
      prevIcon.hidden = !prev;
      prevIcon.setAttribute("aria-label", prev ? "Previous chapter " + prev.l : "Previous chapter");
    }
    if (pullHint) {
      pullHint.hidden = !next;
      var b = pullHint.querySelector("b");
      if (b && next) b.textContent = next.l;
    }
  }

  function applyChapters(list) {
    if (!list || !list.length || !chapEl) return;
    chapterList = list;
    chapEl.textContent = "";
    var label = DATA.chapter;
    for (var i = 0; i < list.length; i += 1) {
      var option = document.createElement("option");
      option.value = list[i].n;
      option.textContent = "Chapter " + list[i].l;
      chapEl.appendChild(option);
      if (String(list[i].n) === String(DATA.chapter)) label = list[i].l;
    }
    chapEl.value = String(DATA.chapter);
    if (chapText) chapText.textContent = "Ch. " + label;
    DATA.label = label;
    DATA.chapters = list;
    renderStoryRows();
    if (!chapWired) {
      chapWired = true;
      chapEl.addEventListener("change", function () {
        if (chapEl.value) {
          flush();
          window.location.href = chapterUrl(chapEl.value);
        }
      });
    }
    updateNext();
  }

  if (chapterList) {
    applyChapters(chapterList);
  } else {
    fetch(DATA.api + "/" + encodeURIComponent(DATA.slug) + "/chapters")
      .then(function (response) { return response.ok ? response.json() : null; })
      .then(function (data) { if (data && data.chapters) applyChapters(data.chapters); })
      .catch(function () { /* no picker; the chapter still reads */ });
  }

  /* Changing width reflows every page, so keep the page the reader is on at the
     same point of the viewport instead of letting the scroll position drift. */
  function setZoom(next, anchor) {
    next = Math.max(0, Math.min(STEPS.length - 1, next));
    if (next === zi) return;
    var fig = anchor || figs[current] || figs[0];
    var offset = fig ? (window.pageYOffset - fig.offsetTop) / Math.max(1, fig.offsetHeight) : 0;
    zi = next;
    pages.style.setProperty("--zoom", STEPS[zi]);
    /* fit width needs no horizontal scroller at all: the extra scrolling layer
       on top of the page scroll is what makes a tall strip stutter on iOS */
    pages.classList.toggle("zoomed", zi > 0);
    pctEl.textContent = Math.round(STEPS[zi] * 100) + "%";
    requestAnimationFrame(function () {
      if (fig) window.scrollTo(0, fig.offsetTop + offset * fig.offsetHeight);
      save();
    });
  }

  document.getElementById("zoom").addEventListener("click", function (event) {
    var button = event.target.closest ? event.target.closest("button") : null;
    if (!button) return;
    var action = button.getAttribute("data-z");
    if (action === "+") setZoom(zi + 1);
    else if (action === "-") setZoom(zi - 1);
    else setZoom(0);
  });

  if (zoomBtn) {
    zoomBtn.addEventListener("click", function (event) {
      event.stopPropagation();
      var open = zoomEl.hidden;
      zoomEl.hidden = !open;
      zoomBtn.setAttribute("aria-expanded", String(open));
      if (open) showChrome();
    });
  }

  document.addEventListener("pointerdown", function (event) {
    if (!zoomEl.hidden && !zoomEl.contains(event.target) && event.target !== zoomBtn) {
      zoomEl.hidden = true;
      zoomBtn.setAttribute("aria-expanded", "false");
    }
  }, true);

  document.addEventListener("keydown", function (event) {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "+" || event.key === "=") { event.preventDefault(); setZoom(zi + 1); }
    else if (event.key === "-") { event.preventDefault(); setZoom(zi - 1); }
    else if (event.key === "0") { event.preventDefault(); setZoom(0); }
  });

  /* double-tap on a page: fit <-> 240%, the size at which a two-page scan is
     readable on a phone without hunting for the zoom control */
  pages.addEventListener("dblclick", function (event) {
    var fig = event.target.closest ? event.target.closest("figure") : null;
    if (!fig) return;
    event.preventDefault();
    setZoom(zi ? 0 : 3, fig);
  });

  /* Which page is under the reading line: the middle 10% of the viewport.
     Everything above and below is preloaded, not observed. */
  if ("IntersectionObserver" in window) {
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        var index = Number(entry.target.getAttribute("data-i")) - 1;
        if (index === current || !(index >= 0)) return;
        current = index;
        paint();
      });
    }, { rootMargin: "-45% 0px -45% 0px", threshold: 0 });
    figs.forEach(function (fig) { observer.observe(fig); });
  }

  function showChrome() {
    body.classList.remove("chrome-off");
  }

  function hideChrome() {
    if (pullDist > 0 || prevPullDist > 0) return;
    if (!zoomEl.hidden) {
      zoomEl.hidden = true;
      if (zoomBtn) zoomBtn.setAttribute("aria-expanded", "false");
    }
    body.classList.add("chrome-off");
  }

  /* Scroll down for immersion.  Once the chrome is away, it stays away while
     scrolling in either direction; a tap brings it back at whatever point of
     the chapter the reader is in. */
  var lastY = window.pageYOffset;
  var downAcc = 0;
  window.addEventListener("scroll", function () {
    var y = window.pageYOffset;
    if (!restoring) {
      var delta = y - lastY;
      if (delta > 0) {
        downAcc += delta;
        if (downAcc > 26 && y > 90) hideChrome();
      } else if (delta < -4) {
        downAcc = 0;
      }
      if (delta !== 0 && !zoomEl.hidden) {
        zoomEl.hidden = true;
        if (zoomBtn) zoomBtn.setAttribute("aria-expanded", "false");
      }
      if (!seenScroll) {
        seenScroll = true;
        if (resumeEl && !resumeEl.hidden) resumeEl.hidden = true;
      }
      save();
      queueWake();
      updateNextHint();
    }
    lastY = y;
  }, { passive: true });

  /* A clean tap toggles the chrome.  With it visible, a tap on the page or on
     either bar gets it out of the way; with it away, the first tap brings it
     back without also pressing whatever was underneath.  Links, the chapter
     picker and the zoom controls keep their own behaviour. */
  function isReaderControl(target) {
    return Boolean(target && target.closest &&
      target.closest("a, button, select, option, input, textarea, label, #zoom, #resume"));
  }

  var chromeTapStart = null;
  document.addEventListener("pointerdown", function (event) {
    if (body.classList.contains("chrome-off")) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (isReaderControl(event.target)) return;
    chromeTapStart = { x: event.clientX, y: event.clientY, t: Date.now() };
  }, true);
  document.addEventListener("pointerup", function (event) {
    if (!chromeTapStart) return;
    var start = chromeTapStart;
    chromeTapStart = null;
    if (Math.abs(event.clientX - start.x) < 12 && Math.abs(event.clientY - start.y) < 12 &&
        Date.now() - start.t < 400) {
      hideChrome();
    }
  }, true);
  window.addEventListener("pointercancel", function () { chromeTapStart = null; }, true);

  /* A firmer touch than a scroll: if the chrome is away, the first tap brings
     it back without also pressing whatever was underneath. */
  var tapStart = null;
  var suppressClick = false;
  document.addEventListener("pointerdown", function (event) {
    if (!body.classList.contains("chrome-off")) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    tapStart = { x: event.clientX, y: event.clientY, t: Date.now() };
  }, true);
  document.addEventListener("pointerup", function (event) {
    if (!tapStart) return;
    var start = tapStart;
    tapStart = null;
    if (Math.abs(event.clientX - start.x) < 12 && Math.abs(event.clientY - start.y) < 12 &&
        Date.now() - start.t < 400) {
      showChrome();
      suppressClick = true;
      setTimeout(function () { suppressClick = false; }, 400);
    }
  }, true);
  window.addEventListener("pointercancel", function () { tapStart = null; }, true);
  document.addEventListener("click", function (event) {
    if (!suppressClick) return;
    suppressClick = false;
    event.preventDefault();
    event.stopPropagation();
  }, true);

  function atTop() {
    return window.pageYOffset <= 1;
  }

  function atBottom() {
    return window.innerHeight + window.pageYOffset >= document.documentElement.scrollHeight - 3;
  }

  /* As the end of the chapter comes up, the next chapter fades in behind the
     pages instead of popping up as a floating button; pulling adds to it. */
  function updateNextHint() {
    if (!pullEl || !nextHref || pullDist > 0 || prevPullDist > 0) return;
    var remaining = document.documentElement.scrollHeight - (window.pageYOffset + window.innerHeight);
    var span = window.innerHeight * 1.25;
    var strength = remaining < span ? Math.max(0, Math.min(1, 1 - remaining / span)) : 0;
    pullEl.classList.remove("prev");
    pullEl.classList.toggle("hint", strength > 0.03);
    pullEl.style.opacity = strength > 0.03 ? String((0.12 + strength * 0.3).toFixed(3)) : "";
    if (pullText) pullText.textContent = nextLabel || "next chapter";
    if (pullKicker) pullKicker.textContent = "next chapter";
  }

  function setPull(distance) {
    pullDist = distance;
    if (mainEl) {
      mainEl.style.transition = distance > 0 ? "none" : "";
      mainEl.style.transform = distance > 0 ? "translateY(-" + (distance * 0.36).toFixed(1) + "px)" : "";
    }
    if (!pullEl) return;
    pullEl.classList.remove("prev");
    pullEl.classList.toggle("on", distance > 0);
    pullEl.classList.toggle("armed", distance >= THRESHOLD);
    pullEl.classList.remove("hint");
    if (pullText) pullText.textContent = nextLabel || "next chapter";
    if (pullKicker) pullKicker.textContent = distance >= THRESHOLD ? "release for chapter" : "next chapter";
    pullEl.style.opacity = distance > 0 ? String(0.35 + Math.min(1, distance / THRESHOLD) * 0.65) : "";
    if (distance >= THRESHOLD && !pullArmed) {
      pullArmed = true;
      try { if (navigator.vibrate) navigator.vibrate(8); } catch (err) {}
    } else if (distance < THRESHOLD) {
      pullArmed = false;
    }
    if (distance === 0) updateNextHint();
  }

  function setPrevPull(distance) {
    prevPullDist = distance;
    if (mainEl) {
      mainEl.style.transition = distance > 0 ? "none" : "";
      mainEl.style.transform = distance > 0 ? "translateY(" + (distance * 0.36).toFixed(1) + "px)" : "";
    }
    if (!pullEl) return;
    pullEl.classList.add("prev");
    pullEl.classList.toggle("on", distance > 0);
    pullEl.classList.toggle("armed", distance >= THRESHOLD);
    pullEl.classList.remove("hint");
    if (pullText) pullText.textContent = prevLabel || "previous chapter";
    if (pullKicker) pullKicker.textContent = distance >= THRESHOLD ? "release for chapter" : "previous chapter";
    pullEl.style.opacity = distance > 0 ? String(0.35 + Math.min(1, distance / THRESHOLD) * 0.65) : "";
    if (distance >= THRESHOLD && !prevPullArmed) {
      prevPullArmed = true;
      try { if (navigator.vibrate) navigator.vibrate(8); } catch (err) {}
    } else if (distance < THRESHOLD) {
      prevPullArmed = false;
    }
    if (distance === 0) updateNextHint();
  }

  /* Pulling says the next chapter is about to be needed.  Warm the Worker's
     chapter cache, the next document, and its first screen of images while the
     finger is still moving, so the hand-off lands on warm caches instead of a
     cold round trip. */
  function warmNext() {
    if (!nextHref || leaving || warmedHref === nextHref) return;
    warmedHref = nextHref;
    var token = nextToken;
    if (!token) {
      var cut = nextHref.lastIndexOf("/");
      token = decodeURIComponent(nextHref.slice(cut + 1));
    }
    if (token) {
      fetch(DATA.api + "/" + encodeURIComponent(DATA.slug) + "/" + encodeURIComponent(token), { cache: "force-cache" })
        .then(function (response) { return response.ok ? response.json() : null; })
        .then(function (data) {
          if (!data || !Array.isArray(data.images)) return;
          for (var i = 0; i < Math.min(4, data.images.length); i += 1) {
            var image = new Image();
            image.decoding = "async";
            image.fetchPriority = i < 2 ? "high" : "low";
            image.src = data.images[i];
            warmImages.push(image);
          }
        })
        .catch(function () { /* the normal navigation still works */ });
    }
    /* The reader is a plain, cacheable GET; reading it now means the navigation
       can reuse the response instead of waiting on a cold render. */
    fetch(nextHref, { cache: "force-cache" })
      .then(function (response) { return response.text(); })
      .catch(function () { /* preload is an optimisation only */ });
  }

  function goNext() {
    if (!nextHref || leaving) return;
    warmNext();
    leaving = true;
    pullActive = false;
    prevPullActive = false;
    flush();
    setPull(0);
    if (veilLabel) veilLabel.textContent = nextLabel || "the next";
    if (veil) veil.classList.add("on");
    setTimeout(function () { window.location.href = nextHref; }, 300);
  }

  function goPrev() {
    if (!prevHref || leaving) return;
    leaving = true;
    pullActive = false;
    prevPullActive = false;
    flush();
    setPrevPull(0);
    if (veilLabel) veilLabel.textContent = prevLabel || "the previous";
    if (veil) veil.classList.add("on");
    setTimeout(function () { window.location.href = prevHref; }, 300);
  }

  [nextEl, nextIcon].forEach(function (link) {
    if (!link) return;
    link.addEventListener("click", function (event) {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      goNext();
    });
  });

  if (prevIcon) {
    prevIcon.addEventListener("click", function (event) {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      if (!prevHref) return;
      event.preventDefault();
      goPrev();
    });
  }

  /* Pull down at the top for the previous chapter; pull up at the bottom for
     the next.  The same indicator follows the finger in either direction. */
  document.addEventListener("touchstart", function (event) {
    wheelAccum = 0;
    if (leaving || event.touches.length !== 1) return;
    if (isReaderControl(event.target)) return;
    if (atTop() && prevHref) {
      prevPullActive = true;
      prevPullStart = event.touches[0].clientY;
      prevPullArmed = false;
      return;
    }
    if (!nextHref || !atBottom()) return;
    pullActive = true;
    pullStart = event.touches[0].clientY;
    pullArmed = false;
  }, { passive: true });

  document.addEventListener("touchmove", function (event) {
    if (prevPullActive) {
      var prevDistance = event.touches[0].clientY - prevPullStart;
      if (prevDistance <= 0) {
        setPrevPull(0);
        return;
      }
      if (!atTop()) {
        prevPullActive = false;
        setPrevPull(0);
        return;
      }
      if (event.cancelable) event.preventDefault();
      setPrevPull(Math.min(150, prevDistance * 0.55));
      return;
    }
    if (!pullActive) return;
    var distance = pullStart - event.touches[0].clientY;
    if (distance <= 0) {
      setPull(0);
      return;
    }
    if (!atBottom()) {
      pullActive = false;
      setPull(0);
      return;
    }
    if (event.cancelable) event.preventDefault();
    warmNext();
    setPull(Math.min(150, distance * 0.55));
  }, { passive: false });

  document.addEventListener("touchend", function () {
    if (prevPullActive) {
      prevPullActive = false;
      if (prevPullDist >= THRESHOLD) goPrev();
      else setPrevPull(0);
      return;
    }
    if (!pullActive) return;
    pullActive = false;
    if (pullDist >= THRESHOLD) goNext();
    else setPull(0);
  }, { passive: true });

  document.addEventListener("touchcancel", function () {
    pullActive = false;
    prevPullActive = false;
    setPull(0);
    setPrevPull(0);
  }, { passive: true });

  /* Desktop/trackpad equivalent, only at the very bottom and only downward. */
  window.addEventListener("wheel", function (event) {
    if (!nextHref || leaving || event.deltaY <= 0 || !atBottom()) {
      if (event.deltaY < 0 && pullDist > 0) {
        wheelAccum = 0;
        setPull(0);
      }
      return;
    }
    if (event.cancelable) event.preventDefault();
    warmNext();
    wheelAccum += event.deltaY;
    setPull(Math.min(150, wheelAccum * 0.3));
    clearTimeout(wheelTimer);
    wheelTimer = setTimeout(function () {
      if (!leaving) {
        wheelAccum = 0;
        setPull(0);
      }
    }, 650);
    if (wheelAccum * 0.3 >= THRESHOLD) goNext();
  }, { passive: false });

  window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") flush();
  });

  if (resumeEl) {
    resumeEl.addEventListener("click", function () {
      if (cancelRestore) cancelRestore();
      resumeEl.hidden = true;
    });
  }

  /* History: restore the exact reading line, not just the page.  Images above
     the target must have their real heights first, or the jump lands short. */
  var saved = null;
  try { saved = JSON.parse(localStorage.getItem(key) || "null"); } catch (err) { saved = null; }

  function restore(position) {
    var target = Math.min(position.i, figs.length - 1);
    var frac = typeof position.f === "number" ? Math.max(0, Math.min(1, position.f)) : 0;
    var pending = 0;
    var finished = false;
    var timer = 0;
    restoring = true;

    function finishJump() {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      cancelRestore = null;
      var fig = figs[target];
      var y = fig.offsetTop + frac * fig.offsetHeight - window.innerHeight * 0.45;
      var max = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
      window.scrollTo(0, Math.max(0, Math.min(y, max)));
      current = target;
      setTimeout(function () {
        restoring = false;
        lastY = window.pageYOffset;
        paint();
      }, 80);
      if (resumeEl) {
        var b = resumeEl.querySelector("b");
        resumeEl.hidden = false;
        if (resumeEl.firstChild) resumeEl.firstChild.nodeValue = "resumed page ";
        if (b) b.textContent = String(target + 1);
        clearTimeout(resumeTimer);
        resumeTimer = setTimeout(function () { resumeEl.hidden = true; }, 2800);
      }
    }

    function cancel() {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      restoring = false;
      cancelRestore = null;
      lastY = window.pageYOffset;
      if (resumeEl) resumeEl.hidden = true;
    }

    cancelRestore = cancel;
    window.addEventListener("touchstart", cancel, { passive: true, once: true });
    window.addEventListener("wheel", cancel, { passive: true, once: true });
    window.addEventListener("keydown", cancel, { once: true });

    if (resumeEl) {
      var label = resumeEl.querySelector("b");
      resumeEl.hidden = false;
      if (resumeEl.firstChild) resumeEl.firstChild.nodeValue = "resuming page ";
      if (label) label.textContent = String(target + 1);
    }

    function check() {
      pending -= 1;
      if (pending <= 0) finishJump();
    }

    for (var i = 0; i <= target; i += 1) {
      (function (img) {
        if (!img || (img.complete && img.naturalWidth)) return;
        pending += 1;
        img.addEventListener("load", check, { once: true });
        img.addEventListener("error", check, { once: true });
        img.loading = "eager";
        img.src = img.getAttribute("src");
      })(figs[i].querySelector("img"));
    }

    if (!pending) finishJump();
    else timer = setTimeout(finishJump, 6000);
  }

  if (saved && typeof saved.i === "number" && saved.i > 0 && saved.i < figs.length) {
    restore(saved);
  } else {
    paint();
  }
})();
</script>
<script>
(function () {
  "use strict";
  var veil = document.createElement("div");
  veil.className = "reader-veil";
  veil.setAttribute("aria-hidden", "true");
  var label = document.createElement("div");
  label.className = "reader-veil-text";
  veil.appendChild(label);
  document.body.appendChild(veil);
  var busy = false;
  var close = document.getElementById("close");
  /* mark the return so the app can raise its own veil before it paints; the
     flag sits before the hash so the story route still parses */
  function withFrom(href) {
    var i = href.indexOf("#");
    var base = i === -1 ? href : href.slice(0, i);
    var hash = i === -1 ? "" : href.slice(i);
    return base + (base.indexOf("?") === -1 ? "?" : "&") + "from=reader" + hash;
  }
  function leave(href) {
    if (busy) return;
    busy = true;
    label.textContent = "exiting reader";
    veil.classList.add("on");
    /* keep the veil up through the navigation instead of fading to black and
       waiting: the app raises the same veil on arrival, so the word carries
       across and only the destination fades it out */
    setTimeout(function () {
      window.location.href = withFrom(href || "/");
    }, 620);
  }
  if (close) {
    close.addEventListener("click", function (event) {
      if (event.button !== 0 || event.metaKey || event.ctrlKey ||
          event.shiftKey || event.altKey) return;
      event.preventDefault();
      leave(close.getAttribute("href") || "/");
    });
  }
})();
</script>
</body>
</html>`;
}

export function readerPage(data) {
  return pageShell(data);
}
