/**
 * The per-title page, rendered on the Worker.
 *
 * Every title in the four catalogues gets a real URL (/t/<shelf>/<id>) with its
 * own head, so a link can be pasted into a chat and unfurl with the cover, and
 * so a crawler that ignores the JSON API still sees the synopsis as text.  This
 * module is pure: it takes a book and its neighbours and returns HTML, which
 * keeps it testable without R2.
 */

const SITE = "mgeko tag wall";

const SHELF_LABELS = {
  series: { label: "mangagg library", site: "mangagg", view: "library" },
  catalog: { label: "mgeko library", site: "mgeko", view: "catalog" },
  mangadex: { label: "mangadex catalogue", site: "mangadex", view: "mangadex" },
  mangaupdates: { label: "mangaupdates catalogue", site: "mangaupdates", view: "updates" },
};

export function shelfInfo(shelf) {
  return SHELF_LABELS[shelf] || SHELF_LABELS.series;
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

/** JSON for a <script> block: "<" is the only character that can end it early. */
function jsonLd(payload) {
  return JSON.stringify(payload).replace(/</g, "\\u003c").replace(/\u2028|\u2029/g, "");
}

function compact(n) {
  const value = Number(n) || 0;
  if (value >= 1e6) return (value / 1e6).toFixed(value >= 1e7 ? 0 : 1).replace(/\.0$/, "") + "M";
  if (value >= 1e3) return (value / 1e3).toFixed(value >= 1e4 ? 0 : 1).replace(/\.0$/, "") + "k";
  return String(value);
}

function oneLine(text, cap) {
  const flat = String(text || "").replace(/\s+/g, " ").trim();
  if (flat.length <= cap) return flat;
  const cut = flat.slice(0, cap);
  const space = cut.lastIndexOf(" ");
  return (space > cap * 0.6 ? cut.slice(0, space) : cut).replace(/[,;:\s]+$/, "") + "…";
}

const STYLE = `*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:#ffffff;color:#454549;font:16px/1.6 "DM Sans",ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
a{color:#6c5edc;text-decoration:none}
a:hover{text-decoration:underline;text-underline-offset:3px}
:focus-visible{outline:2px solid #18181a;outline-offset:3px}
/* a floating pill rather than a full-width strip: it keeps the same left edge
   as the cover column below it, and the page shows through around it */
header{position:sticky;top:10px;z-index:9;display:flex;align-items:center;justify-content:space-between;gap:24px;height:56px;width:min(1176px,calc(100% - 20px));margin:10px auto 0;padding:0 clamp(14px,2.4vw,22px) 0 clamp(20px,4vw,32px);border-radius:999px;border:1px solid #e6e6e8;background:rgba(255,255,255,.9);backdrop-filter:blur(18px) saturate(1.3);box-shadow:0 8px 28px rgba(24,24,26,.07)}
.brand{font-size:16px;font-weight:600;letter-spacing:-.01em;color:#18181a;white-space:nowrap;margin-right:auto}
.brand:hover{text-decoration:none}
/* the way out: a round back button in the floating header, so a page opened from
   a chat or a new tab is never a dead end */
.back{display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;flex:none;border-radius:50%;border:1px solid #e6e6e8;background:#ffffff;color:#18181a;transition:background .14s,border-color .14s,color .14s}
.back svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round}
.back:hover{background:#efecff;border-color:#cfc7ff;color:#6c5edc;text-decoration:none}
nav{display:flex;gap:2px;font-size:16px}
nav a{color:#18181a;padding:7px 14px;border-radius:999px;transition:background .14s,color .14s}
nav a:hover{background:#efecff;color:#6c5edc;text-decoration:none}
main{max-width:1176px;margin:0 auto;padding:0 clamp(20px,4vw,32px) 64px}

/* ---- cover left, editorial type right; the cover keeps its own proportions */
.hero{display:grid;grid-template-columns:minmax(0,400px) minmax(0,1fr);gap:clamp(24px,3vw,44px);align-items:start;padding:clamp(30px,3.6vw,48px) 0 64px}
.hero.noart{grid-template-columns:minmax(0,1fr)}
.col-poster{min-width:0;max-width:400px}
.poster{margin:0}
.cover{display:block;width:100%;height:auto;border-radius:12px;background:#f4f4f5;box-shadow:0 0 24px rgba(0,0,0,.22)}
/* ---------- the action buttons ----------
   Outline that fills on hover (Uiverse "reshades"), recoloured for a white
   page: violet keyline and graphite label at rest, filled violet with white
   type on hover, and the icon sliding right.  A fixed 8.5em box keeps the
   three of them exactly the same width. */
.actions{display:flex;flex-wrap:wrap;gap:10px;margin:0 0 32px}
.button{
  position:relative;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:flex-end;
  width:8.5em;height:2.9em;padding:0 1.05em 0 2.5em;
  background:transparent;color:#18181a;border:.2em solid #6c5edc;border-radius:11px;
  font:inherit;font-size:15px;font-weight:600;text-align:right;text-decoration:none;
  cursor:pointer;transition:all .6s ease;
}
.button:hover,.button:focus-visible{background:#6c5edc;color:#ffffff;text-decoration:none}
.button svg{
  position:absolute;left:.9em;top:50%;width:1.35em;height:1.35em;margin-top:-.675em;
  fill:currentColor;transition:all .6s ease;pointer-events:none;
}
.button:hover svg,.button:focus-visible svg{transform:translateX(5px)}
.button .text{white-space:nowrap}

/* the type column has a rule of its own, so it reads as a column rather than
   as paragraphs floating beside a picture */
.info{min-width:0;padding:4px 0 0 clamp(20px,2.6vw,36px);border-left:1px solid #eeeef0}
.eyebrow{margin:0 0 20px;font-size:12px;letter-spacing:.18em;text-transform:uppercase;color:#707077;font-weight:500}
.eyebrow b{color:#18181a;font-weight:600}
.eyebrow i{font-style:normal;color:#cfcfd1;padding:0 8px}
/* the one claim on the page with an expiry: a title the catalogue gained in the
   last week.  Lavender and violet, not a filled button -- it marks the record, it
   does not ask to be clicked. */
.pill-new{display:inline-block;margin-left:10px;padding:3px 10px;border-radius:48px;background:#efecff;color:#6c5edc;font-size:10px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;vertical-align:1px}
h1{font-size:clamp(34px,4.6vw,60px);line-height:1.13;letter-spacing:-.015em;color:#18181a;margin:0 0 16px;font-weight:600;overflow-wrap:anywhere}
.alt{margin:0 0 24px;color:#707077;font-size:15px;line-height:1.55}

.meta{margin:0 0 32px;font-size:14px;color:#707077;line-height:1.6}
.meta b{color:#18181a;font-weight:600}
.meta em{font-style:normal;font-size:12px;color:#b7b7bb;margin-left:1px}
.meta i{font-style:normal;color:#cfcfd1;padding:0 8px}

/* the synopsis gets a margin of its own: a label in the gutter, the prose
   beside it, and a rule above -- the text is never alone on the page */
.block{display:grid;grid-template-columns:118px minmax(0,1fr);gap:clamp(18px,2.4vw,34px);align-items:start;margin-top:32px;padding-top:32px;border-top:1px solid #e6e6e8}
.block .label{margin:0;padding-top:5px}
.prose{min-width:0}
.label{margin:0 0 14px;font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:#707077;font-weight:600}
.lead{margin:0 0 18px;font-size:20px;line-height:1.5;color:#18181a;max-width:56ch}
.synopsis{margin:0;font-size:16px;line-height:1.6;color:#454549;max-width:62ch;white-space:pre-line;overflow-wrap:anywhere}

/* what the poster is and where it came from, under the poster itself */
.colophon{display:grid;gap:4px;margin-top:26px;padding-top:18px;border-top:1px solid #e6e6e8;max-width:400px}
.colophon .cl{font-size:9.5px;letter-spacing:.18em;text-transform:uppercase;color:#b7b7bb;font-weight:600}
.colophon .cv{font-size:13px;line-height:1.45;color:#454549}
.colophon .cx{font-size:12px;color:#6c5edc;margin-top:4px;width:fit-content}
.note{margin:0;font-size:16px;line-height:1.6;color:#707077;max-width:56ch}

/* a second way back, at the end of a long page rather than only at the top */
.retreat{margin:56px 0 0;padding-top:32px;border-top:1px solid #e6e6e8}
.retreat a{display:inline-flex;align-items:center;gap:8px;padding:11px 18px;border-radius:11px;border:.18em solid #18181a;color:#18181a;font-size:14px;font-weight:600;transition:all .3s ease}
.retreat a:hover{background:#18181a;color:#ffffff;text-decoration:none}

.tags{display:flex;flex-wrap:wrap;align-items:baseline;margin:24px 0 0;font-size:15px;line-height:1.6;color:#6c5edc}
.tags .k{color:#707077;margin-right:10px;font-size:11px;letter-spacing:.16em;text-transform:uppercase;font-weight:600}
.tags i{font-style:normal;color:#cfcfd1;padding:0 7px}
.tags a{color:#6c5edc;border-radius:5px;padding:2px 4px;transition:background .14s}
.tags a:hover{background:#efecff;text-decoration:none}

/* ---- the collection: a floating lavender gallery that closes the page ----- */
section{margin-top:64px}
.sec-head{display:flex;align-items:baseline;justify-content:space-between;gap:16px;margin:0 0 24px}
.sec-head h2{margin:0;font-size:26px;line-height:1.25;font-weight:600;color:#18181a;letter-spacing:-.015em}
.sec-head .count{font-size:14px;color:#707077}
.panel{
  background:#c9c1ff;border-radius:24px;padding:clamp(16px,2vw,26px);
  box-shadow:0 24px 50px -12px rgba(24,24,26,.28),0 2px 0 rgba(255,255,255,.5) inset;
}
.strip{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:clamp(12px,1.6vw,18px);align-items:start}
.tile{display:block;color:#18181a;min-width:0}
.tile:hover{text-decoration:none}
.tile .frame{
  display:flex;align-items:center;justify-content:center;aspect-ratio:1/1.44;
  border-radius:12px;background:#ffffff;overflow:hidden;
  box-shadow:0 0 18px rgba(0,0,0,.1);transition:transform .18s ease,box-shadow .18s ease;
}
.tile:hover .frame,.tile:focus-visible .frame{transform:translateY(-4px);box-shadow:0 16px 30px rgba(24,24,26,.22)}
.tile img{max-width:100%;max-height:100%;width:auto;height:auto;display:block}
.tile .ph{color:#b7b7bb;font-size:28px;font-weight:500}
.tile .t{display:block;margin-top:10px;font-size:13.5px;line-height:1.45;color:#18181a;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.tile:hover .t{text-decoration:underline;text-underline-offset:3px}

/* the hover card: same information as the wall's peek, in the page's own voice */
.tip{
  position:fixed;left:0;top:0;z-index:30;width:min(330px,calc(100vw - 24px));padding:13px 15px;
  border-radius:12px;border:1px solid #e6e6e8;background:#ffffff;color:#454549;
  box-shadow:0 0 24px rgba(0,0,0,.22);font-size:12.5px;line-height:1.55;
  opacity:0;pointer-events:none;transition:opacity .13s ease;
}
.tip.on{opacity:1}
.tip b{display:block;margin-bottom:5px;font-size:13px;font-weight:600;color:#18181a;line-height:1.35}
.tip span{display:-webkit-box;-webkit-line-clamp:7;-webkit-box-orient:vertical;overflow:hidden}

/* ---- inverted footer ----------------------------------------------------- */
footer{margin-top:64px;background:#18181a;color:#cfcfd1;font-size:14px;line-height:1.5}
.foot-in{max-width:1176px;margin:0 auto;padding:40px clamp(20px,4vw,32px);font-family:Arial,Helvetica,sans-serif}
footer a{color:#cfcfd1}
footer a:hover{color:#ffffff}

@media (max-width:940px){.hero{grid-template-columns:minmax(0,320px) minmax(0,1fr);gap:40px}.col-poster{max-width:320px}.strip{grid-template-columns:repeat(3,minmax(0,1fr))}}
@media (max-width:700px){
  header{height:52px;top:8px;width:calc(100% - 16px);gap:10px;padding:0 10px 0 10px}
  nav{display:none}
  .back{width:32px;height:32px}
  .brand{font-size:15px}
  /* three 8.5em buttons cannot fit a phone: two share the first row, the third
     takes the next one full width */
  .button{flex:1 1 calc(50% - 5px);width:auto;min-width:0;justify-content:center;padding:0 1em 0 2.3em}
  .actions{gap:8px;margin-bottom:26px}
  .retreat{margin-top:36px;padding-top:24px}
  .retreat a{display:flex;width:100%;justify-content:center;padding:15px;font-size:15px}
  .hero{grid-template-columns:1fr;gap:30px;padding:24px 0 8px}
  .info{border-left:0;padding-left:0}
  .block{grid-template-columns:1fr;gap:12px}
  .block .label{padding-top:0}
  .col-poster{max-width:min(74vw,340px)}
  h1{font-size:clamp(30px,7.6vw,40px)}
  .actions{flex-direction:row;flex-wrap:wrap;align-items:center}
  .block{padding-top:24px;margin-top:24px}
  .panel{padding:14px;border-radius:18px}
  .strip{grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
  .tile .t{font-size:12.5px}
}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
`;

function head({ origin, canonical, title, description, image, extraRobots }) {
  const ogTitle = esc(title);
  const ogDesc = esc(description);
  return (
    '<meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    "<title>" + esc(title) + "</title>" +
    '<meta name="description" content="' + ogDesc + '">' +
    (extraRobots ? '<meta name="robots" content="' + extraRobots + '">' : "") +
    '<link rel="canonical" href="' + esc(canonical) + '">' +
    '<meta property="og:type" content="book">' +
    '<meta property="og:site_name" content="' + esc(SITE) + '">' +
    '<meta property="og:title" content="' + ogTitle + '">' +
    '<meta property="og:description" content="' + ogDesc + '">' +
    '<meta property="og:url" content="' + esc(canonical) + '">' +
    (image ? '<meta property="og:image" content="' + esc(image) + '">' : "") +
    /* the cover is the page: start it before the parser reaches the <img>, and
       keep it ahead of the eight related posters behind it in the queue */
    (image ? '<link rel="preload" as="image" href="' + esc(image) + '" fetchpriority="high">' : "") +
    '<meta name="twitter:card" content="' + (image ? "summary_large_image" : "summary") + '">' +
    '<meta name="twitter:title" content="' + ogTitle + '">' +
    '<meta name="twitter:description" content="' + ogDesc + '">' +
    (image ? '<meta name="twitter:image" content="' + esc(image) + '">' : "") +
    '<link rel="preconnect" href="https://fonts.googleapis.com">' +
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
    '<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600&display=swap" rel="stylesheet">' +
    '<meta name="color-scheme" content="light">' +
    '<meta name="theme-color" content="#ffffff">'
  );
}

function shell({ origin, body, inlineScript }) {
  return (
    "<!doctype html><html lang=\"en\"><head>" + body.head + "<style>" + STYLE + "</style>" +
    "</head><body>" +
    '<header><a class="back" id="back" href="/" aria-label="Back to browse">' + ICON_BACK + "</a>" +
    '<a class="brand" href="/">' + esc(SITE) + "</a>" +
    '<nav><a href="/">browse all</a><a href="/#updates">newest</a></nav></header>' +
    body.main +
    '<footer><div class="foot-in">' + body.foot + "</div></footer>" +
    (inlineScript ? "<script>" + inlineScript + "</script>" : "") +
    "</body></html>"
  );
}

/** Shared by the title page and the 404: copy the link, or hand it to the OS. */
const SHARE_SCRIPT = `
(function(){
  var url = document.querySelector('link[rel=canonical]').href;
  var title = document.title;
  function flash(btn, text){
    /* the button is an orb with a label under it now, so only the label may
       change -- replacing textContent would throw the orb away */
    var label = btn.querySelector('.text') || btn;
    var old = label.textContent;
    label.textContent = text;
    setTimeout(function(){ label.textContent = old; }, 1400);
  }
  /* Back leaves the way it came.  A page reached from a grid goes back to that
     grid with its scroll intact; a page opened from a chat or a fresh tab has no
     usable history, so it falls through to the href, which is the site root. */
  var back = document.getElementById('back');
  if (back) back.addEventListener('click', function(event){
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    try {
      var ref = document.referrer || '';
      if (ref && new URL(ref).origin === location.origin && history.length > 1) {
        event.preventDefault();
        history.back();
      }
    } catch (e) {}
  });
  var share = document.getElementById('share');
  if (share) share.addEventListener('click', function(){
    if (navigator.share) { navigator.share({ title: title, url: url }).catch(function(){}); return; }
    copy(share);
  });
  var copyBtn = document.getElementById('copy');
  if (copyBtn) copyBtn.addEventListener('click', function(){ copy(copyBtn); });
  function copy(btn){
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(function(){ flash(btn, 'copied'); }, function(){ fallback(btn); });
      return;
    }
    fallback(btn);
  }
  function fallback(btn){
    var input = document.createElement('input');
    input.value = url;
    document.body.appendChild(input);
    input.select();
    try { document.execCommand('copy'); flash(btn, 'copied'); } catch (e) { flash(btn, 'press ctrl+c'); }
    input.remove();
  }
  /* opening a title counts as opening it in the wall's own "not opened yet"
     count, which lives in this browser only */
  try {
    var key = 'discover:seen:v1';
    var seen = JSON.parse(localStorage.getItem(key) || '[]');
    var id = document.body.getAttribute('data-ident');
    if (id && seen.indexOf(id) === -1) {
      seen.push(id);
      localStorage.setItem(key, JSON.stringify(seen.slice(-4000)));
    }
  } catch (e) {}
  /* the same anonymous page counter the wall runs, so a link that was shared
     into a chat still shows up in /stats */
  try {
    var id = localStorage.getItem('visitor:id');
    var fresh = false;
    if (!id) {
      id = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now();
      localStorage.setItem('visitor:id', id);
      fresh = true;
    }
    fetch('/api/ping', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: id, fresh: fresh }),
      keepalive: true
    }).catch(function(){});
  } catch (e) {}
})();
`;

/** Genres as plain text links, middot-separated: no badges, no borders. */
/* Hovering a poster in the collection floats that title's synopsis above it.
   One ranged read on the Worker per title, cached at the edge for a day; the
   card never takes pointer events, so it cannot steal the next mouseover. */
const RELATED_SCRIPT = `
(function(){
  var strip = document.querySelector('.strip');
  if (!strip) return;
  var shelf = strip.getAttribute('data-shelf') || '';
  var tip = document.createElement('div');
  tip.className = 'tip';
  tip.setAttribute('role', 'tooltip');
  document.body.appendChild(tip);
  var cache = {};
  var timer = 0;
  var active = null;

  function place(el){
    var box = el.getBoundingClientRect();
    var width = tip.offsetWidth || 330;
    var height = tip.offsetHeight || 110;
    var pad = 10;
    var left = Math.max(pad, Math.min(box.left, window.innerWidth - width - pad));
    var top = box.top - height - 10;
    if (top < pad) top = Math.min(box.bottom + 10, window.innerHeight - height - pad);
    tip.style.transform = 'translate3d(' + Math.round(left) + 'px,' + Math.round(top) + 'px,0)';
  }

  function synopsis(data){
    return data.description || data.teaser || 'No synopsis indexed for this title yet.';
  }

  function show(el){
    var ident = el.getAttribute('data-ident');
    if (!ident) return;
    active = el;
    tip.textContent = '';
    var head = document.createElement('b');
    head.textContent = el.getAttribute('data-title') || '';
    var text = document.createElement('span');
    text.textContent = cache[ident] || 'Loading the synopsis…';
    tip.appendChild(head);
    tip.appendChild(text);
    tip.classList.add('on');
    place(el);
    if (cache[ident]) return;
    fetch('/api/about/' + shelf + '/' + encodeURIComponent(ident))
      .then(function(res){ return res.ok ? res.json() : null; })
      .then(function(data){
        if (!data) return;
        cache[ident] = synopsis(data);
        if (active === el && tip.classList.contains('on')) {
          text.textContent = cache[ident];
          place(el);
        }
      })
      .catch(function(){});
  }

  function hide(){
    clearTimeout(timer);
    active = null;
    tip.classList.remove('on');
  }

  /* Touch has no hover, so holding a tile for 380ms opens the same card.  The
     hold must not also follow the link, so the click that follows a hold is
     swallowed; an ordinary tap is left alone. */
  var holdTimer = 0;
  var heldAt = 0;
  var holdTile = null;
  function cancelHold(){ clearTimeout(holdTimer); holdTimer = 0; }
  strip.addEventListener('pointerdown', function(event){
    if (event.pointerType !== 'touch') return;
    var tile = event.target.closest ? event.target.closest('.tile') : null;
    cancelHold();
    if (!tile) return;
    holdTile = tile;
    holdTimer = setTimeout(function(){
      holdTimer = 0;
      heldAt = Date.now();
      show(tile);
      try { if (navigator.vibrate) navigator.vibrate(10); } catch (e) {}
    }, 380);
  });
  strip.addEventListener('pointermove', function(event){
    if (event.pointerType !== 'touch' || !holdTimer) return;
    var tile = event.target.closest ? event.target.closest('.tile') : null;
    if (tile !== holdTile) cancelHold();
  });
  strip.addEventListener('pointerup', function(event){
    if (event.pointerType !== 'touch') return;
    if (holdTimer) { cancelHold(); return; }
    holdTile = null;
    setTimeout(hide, 2000);
  });
  strip.addEventListener('pointercancel', cancelHold);
  strip.addEventListener('click', function(event){
    if (Date.now() - heldAt > 900) return;
    event.preventDefault();
    event.stopPropagation();
  }, true);

  strip.addEventListener('mouseover', function(event){
    var tile = event.target.closest ? event.target.closest('.tile') : null;
    if (!tile) { hide(); return; }
    if (tile === active) return;
    active = tile;
    clearTimeout(timer);
    timer = setTimeout(function(){ if (active === tile) show(tile); }, 110);
  });
  strip.addEventListener('mouseleave', hide);
  strip.addEventListener('focusin', function(event){
    var tile = event.target.closest ? event.target.closest('.tile') : null;
    if (tile) show(tile);
  });
  strip.addEventListener('focusout', hide);
  window.addEventListener('scroll', hide, { passive: true });
  window.addEventListener('resize', hide);
})();
`;

const ICON_BACK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.5 5.5 8 12l6.5 6.5"></path></svg>';
const ICON_READ = '<svg class="svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.6h10.4V16h-2.6V9.9l-8.5 8.5-1.8-1.8 8.5-8.5H8V5.6z"></path></svg>';
const ICON_SHARE = '<svg class="svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.6l5.2 5.2h-3.7v6.4H10.5V7.8H6.8L12 2.6zM4.5 16.2h15v5.2h-15v-5.2z"></path></svg>';
const ICON_COPY = '<svg class="svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 2.8h9.2a3 3 0 0 1 3 3V15h-2.6V5.8a.4.4 0 0 0-.4-.4H9V2.8zM4 8h11.2v13.2H4V8z"></path></svg>';

function tagLinks(tags, view) {
  const links = (tags || []).map((tag) =>
    '<a href="/#' + esc(view) + "?q=" + encodeURIComponent(tag) + '">' + esc(tag) + "</a>"
  );
  if (!links.length) return "";
  return '<p class="tags"><span class="k">Genres</span>' + links.join("<i>·</i>") + "</p>";
}

/**
 * One line of plain text, middot-separated.  The rating is the only thing set
 * brighter, and nothing gets a border: this is a caption, not a dashboard.
 */
function metaLine(book) {
  const bits = [];
  if (book.rating) {
    bits.push("<b>" + esc(book.rating) + "</b><em>/" + (book.bestRating === 5 ? "5" : "10") + "</em>");
  }
  if (book.votes) {
    bits.push(compact(book.votes) + (Number(book.votes) === 1 ? " vote" : " votes"));
  }
  if (book.views) bits.push(compact(book.views) + " views");
  if (book.status) bits.push(esc(book.status));
  if (book.updated) bits.push("updated " + esc(book.updated));
  return bits.length ? '<p class="meta">' + bits.join("<i>·</i>") + "</p>" : "";
}

/** The first sentence can carry the page as a lead paragraph; the rest follows. */
function splitLead(text) {
  const flat = String(text || "").trim();
  const match = flat.match(/^([\s\S]{40,260}?[.!?])\s+/);
  if (!match) return [flat, ""];
  const rest = flat.slice(match[0].length).trim();
  if (rest.length < 80) return [flat, ""];
  return [match[1], rest];
}

/** "Horror · 8 titles" beside the collection heading. */
function collectionNote(label, count) {
  const name = String(label || "").replace(/^More (from )?/, "").trim();
  const size = count + (count === 1 ? " title" : " titles");
  return name ? name + " · " + size : size;
}

function relatedGrid(items, shelf) {
  if (!items || !items.length) return "";
  const tiles = items.map((item) => {
    const href = "/t/" + shelf + "/" + encodeURIComponent(item.ident);
    /* the frame is a fixed tile, but the poster inside is never cropped: it is
       scaled to fit, so a 2:3 cover and a 1:1.4 one both show in full */
    const media = item.cover
      ? '<img src="' + esc(item.cover) + '" alt="" loading="lazy" decoding="async">'
      : '<span class="ph">' + esc((item.title || "?").trim().charAt(0).toUpperCase() + "") + "</span>";
    return '<a class="tile" href="' + esc(href) + '" data-ident="' + esc(item.ident) +
      '" data-title="' + esc(item.title) + '"><span class="frame">' + media +
      '</span><span class="t">' + esc(item.title) + "</span></a>";
  }).join("");
  return tiles;
}

export function titlePage({ origin, shelf, book, related, relatedLabel, noindex }) {
  const info = shelfInfo(shelf);
  const canonical = origin + "/t/" + shelf + "/" + encodeURIComponent(book.ident);
  const description = oneLine(book.description || book.teaser || "", 300) ||
    (book.title + " — " + info.label + (book.year ? " (" + book.year + ")" : "") +
     ". Cover, tags and a link to the source on " + SITE + ".");
  const image = book.ogImage || "";
  const title = book.title + " — " + SITE;

  const structured = {
    "@context": "https://schema.org",
    "@type": "Book",
    name: book.title,
    url: canonical,
    inLanguage: "en",
  };
  if (image) structured.image = image;
  if (book.description) structured.description = oneLine(book.description, 900);
  if (book.tags && book.tags.length) structured.genre = book.tags.slice(0, 8);
  if (book.year) structured.datePublished = String(book.year);
  if (book.sourceUrl) structured.sameAs = book.sourceUrl;
  if (book.rating) {
    structured.aggregateRating = {
      "@type": "AggregateRating",
      ratingValue: String(book.rating),
      bestRating: String(book.bestRating || 10),
    };
    if (book.votes) structured.aggregateRating.ratingCount = Number(book.votes);
  }

  /* mangagg titles read in this site's reader; the other catalogues hand off
     to the source, which is where their chapters actually are */
  const readerHref = shelf === "series" && book.ident
    ? "/reader/series/" + encodeURIComponent(book.ident)
    : "";
  const readHref = readerHref || book.sourceUrl;
  const readAria = readerHref ? "Read in the reader" : "Read on " + info.site;
  const actions =
    '<div class="actions">' +
    (readHref
      ? '<a class="button" id="read" href="' + esc(readHref) +
        '" rel="noopener noreferrer" target="_blank" aria-label="' + esc(readAria) + '">' +
        ICON_READ + '<span class="text">read</span></a>'
      : "") +
    '<button class="button" id="share" type="button" aria-label="Share this page">' +
    ICON_SHARE + '<span class="text">share</span></button>' +
    '<button class="button" id="copy" type="button" aria-label="Copy the link">' +
    ICON_COPY + '<span class="text">copy link</span></button>' +
    "</div>";

  const main =
    "<main>" +
    '<div class="hero' + (image ? "" : " noart") + '">' +
    /* the cover and its two actions are one column, so the type column starts clean */
    '<div class="col-poster">' +
    '<figure class="poster">' +
    (image
      ? '<img class="cover" src="' + esc(image) + '" alt="Cover of ' + esc(book.title) +
        '" width="460" height="690" fetchpriority="high" decoding="async">'
      : "") +
    "</figure>" +
    (book.sourceUrl
      ? '<div class="colophon"><span class="cl">catalogue</span>' +
        '<span class="cv">' + esc(info.label) + "</span>" +
        '<a class="cx" href="' + esc(book.sourceUrl) + '" rel="noopener noreferrer" target="_blank">' +
        "open on " + esc(info.site) + ' <span aria-hidden="true">↗</span></a>' +
        "</div>"
      : "") +
    "</div>" +
    '<div class="info">' +
    '<p class="eyebrow"><b>' + esc(info.label) + "</b>" +
    (book.isNew ? '<span class="pill-new">new story</span>' : "") +
    (book.badge ? "<i>—</i>" + esc(book.badge) : "") +
    (book.year ? "<i>—</i>" + esc(book.year) : "") + "</p>" +
    "<h1>" + esc(book.title) + "</h1>" +
    (book.alt && book.alt.length
      ? '<p class="alt">also known as ' + esc(book.alt.join(" · ")) + "</p>"
      : "") +
    metaLine(book) +
    actions +
    '<div class="block"><p class="label">Synopsis</p><div class="prose">' +
    (book.description
      ? (() => {
          const [lead, rest] = splitLead(book.description);
          return rest
            ? '<p class="lead">' + esc(lead) + '</p><p class="synopsis">' + esc(rest) + "</p>"
            : '<p class="synopsis">' + esc(lead) + "</p>";
        })()
      : '<p class="note">' + esc(info.site) + " has no synopsis for this title yet — the link beside the cover goes straight to the source.</p>") +
    (book.tags && book.tags.length ? tagLinks(book.tags, info.view) : "") +
    "</div></div>" +
    "</div></div>" +
    (related && related.length
      ? "<section>" +
        '<div class="sec-head"><h2>More from this Collection</h2><span class="count">' +
        esc(collectionNote(relatedLabel, related.length)) + "</span></div>" +
        '<div class="panel"><div class="strip" data-shelf="' + esc(shelf) + '">' +
        relatedGrid(related, shelf) + "</div></div>" +
        "</section>"
      : "") +
    '<p class="retreat"><a href="/"><span aria-hidden="true">←</span> back to browse</a></p>' +
    "</main>";

  const foot =
    "Titles, covers and synopses belong to " + esc(info.site) +
    " and the other catalogues this wall indexes — every link above opens the source page. " +
    'No ads, no accounts, no tracking beyond a page counter. <a href="/">Back to the wall</a>';

  return shell({
    origin,
    body: {
      head: head({
        origin,
        canonical,
        title,
        description,
        image,
        extraRobots: noindex ? "noindex, follow" : "",
      }) + '<script type="application/ld+json">' + jsonLd(structured) + "</script>",
      main,
      foot,
    },
    inlineScript: SHARE_SCRIPT + RELATED_SCRIPT,
  }).replace("<body>", '<body data-ident="' + esc(shelf + ":" + book.ident) + '">');
}

export function notFoundPage({ origin, shelf, ident }) {
  const info = shelf ? shelfInfo(shelf) : null;
  const title = "Not in this catalogue — " + SITE;
  const description = "That title id is not in the " + (info ? info.label : "index") + ".";
  const main =
    "<main><p class=\"crumb\">" + (info ? esc(info.label) : "unknown shelf") + "</p>" +
    "<h1>Nothing here</h1>" +
    '<p class="note">' + esc(ident || "") + " is not a title id this wall knows about. " +
    "Ids come from the catalogue, so a typo or an old bookmark lands here. " +
    '<a href="/">Search the wall instead</a>.</p></main>';
  return shell({
    origin,
    body: {
      head: head({
        origin,
        canonical: origin + "/t",
        title,
        description,
        image: "",
        extraRobots: "noindex, follow",
      }),
      main,
      foot: "Titles, covers and synopses belong to their sources.",
    },
    inlineScript: "",
  });
}
