#!/usr/bin/env bash
# One harvest run on a clean machine: put the scripts where their relative paths
# expect, restore the state, crawl, rebuild the harvest half of the site, upload.
#
#   bash harvest_job.sh prepare   # layout + state + static inputs
#   bash harvest_job.sh run       # crawl, rebuild, upload
#   bash harvest_job.sh save      # push state back to the bucket
#   bash harvest_job.sh all       # all three
set -uo pipefail
ROOT=$(cd "$(dirname "$0")" && pwd)
WS=$ROOT/ws
UI=$WS/mgeko-tags-ui
TG=$WS/mgeko-tags
MAX=${HARVEST_MAX:-6000}

prepare() {
  mkdir -p "$UI/cache/cron" "$UI/cache/sources" "$UI/cache/kun_index" \
           "$TG/output" "$TG/cache/catalog" "$TG/cloud"
  cp "$ROOT"/cron_kunmanga.py "$ROOT"/cron_comick.py "$ROOT"/crawl_sources.py "$UI"/
  cp "$ROOT"/build_harvest.py "$ROOT"/build_harvest_chapters.py "$ROOT"/build_data.py \
     "$ROOT"/build_library_desc.py "$ROOT"/build_complete.py "$ROOT"/r2_sync.py "$TG/cloud"/
  echo "state:"
  python3 "$ROOT/state_sync.py" pull || echo "state pull had gaps"
  python3 "$ROOT/state_sync.py" inputs --download --if-missing || return 1
}

run() {
  cd "$UI" || return 1
  echo "kunmanga:"
  python3 cron_kunmanga.py --days 3 --max "$MAX" || echo "kunmanga step failed"
  echo "comick:"
  python3 cron_comick.py --days 3 --max 400 || echo "comick step failed"
  # bato1 has no incremental crawler: its shelf is the original import, and its
  # dates come from the series sitemaps, 18 files of one lastmod per series
  # the crawl state only holds the series a run fetched; kunmanga's five series
  # sitemaps carry a date for all ~97k, and that is where untouched rows get one
  echo "kun dates:"
  python3 "$ROOT/kun_stamps.py" || echo "kun date step failed"
  echo "bato dates:"
  python3 "$ROOT/bato_stamps.py" || echo "bato date step failed"
  # the crawl appends a record per series, so without this the delta doubles
  # every run and every state pull and push carries the duplicates
  echo "compact:"
  python3 "$ROOT/compact_delta.py" "$UI/cache/cron/kunmanga.delta.jsonl" || return 1
  echo "rows:"
  python3 "$TG/cloud/build_harvest.py" || return 1
  echo "shards:"
  python3 "$TG/cloud/build_harvest_chapters.py" || return 1
  echo "shelves:"
  python3 "$TG/cloud/build_data.py" --harvest-only || return 1
  # The harvest shelf ships no synopsis.  Fill it from the mangadex and
  # mangaupdates rows already in R2, aligned to the rows.bin just packed.
  # A failed merge keeps the uploaded table rather than replacing it with an
  # empty one, so descriptions never disappear because a download hiccupped.
  echo "descriptions:"
  if ! python3 "$TG/cloud/build_library_desc.py" --fetch; then
    echo "description merge skipped; keeping the uploaded meta.bin"
    rm -f "$TG/cloud/data/library/meta.bin"
  fi
  echo "upload:"
  cd "$TG/cloud" || return 1
  python3 r2_sync.py || return 1
  # MangaDex's own publication status, matched to the rows just uploaded: this
  # is the list behind the app's "completed" badge.  A failed merge keeps the
  # uploaded one rather than replacing it with a half-built file, and it is not
  # worth failing a whole harvest run over.
  echo "completed:"
  python3 "$TG/cloud/build_complete.py" --rows "$TG/output/harvest.tsv" --upload || \
    echo "completion list skipped; keeping the uploaded one"
}

save() {
  echo "state:"
  python3 "$ROOT/state_sync.py" push
}

case "${1:-all}" in
  prepare) prepare ;;
  run) run ;;
  save) save ;;
  all) prepare && run; rc=$?; save; exit $rc ;;
  *) echo "usage: $0 [prepare|run|save|all]" >&2; exit 2 ;;
esac
