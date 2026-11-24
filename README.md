# mgeko harvest

Runs the kunmanga + Comick harvest every six hours on GitHub Actions instead of
a laptop cron, rebuilds the harvest half of the site, and uploads it to R2.

    every 6h:  prepare -> run -> save
    prepare    lay the scripts out, pull state from R2, restore static inputs
    run        crawl, build harvest rows + reader shards, rebuild the library
               shelf and catalog feed, upload the changed objects
    save       push the lastmod state, delta rows and upload manifest back

Only the library shelf and the catalog feed are rebuilt here.  The mangadex and
mangaupdates shelves and the sitemap come from the full local build, and are
left untouched by these runs.

## State

| Where | What |
| --- | --- |
| `state/kunmanga.json` | slug -> last sitemap lastmod seen |
| `state/kunmanga.delta.jsonl.gz` | the rows the crawler wrote |
| `state/comick.json`, `state/comick.jsonl.gz` | Comick's incremental state |
| `state/import_slugs.txt.gz` | slugs the backfill already holds |
| `state/upload-state.json` | sha256 per object, so unchanged files stay put |
| `state/inputs.tar.gz` | the static inputs, mirrored by the Actions cache |

To refresh the static inputs after re-running the backfill:

    python3 state_sync.py inputs --upload --source /path/to/parent
    # then bump the cache key in .github/workflows/harvest.yml

## Setup that has to be done by hand, once

1. `gh repo create <owner>/mgeko-harvest --public --source . --push`
   (public gives unlimited Actions minutes; private Free gets ~2,000/month)
2. `gh secret set CLOUDFLARE_API_TOKEN` — a token with **Workers R2: Edit**
3. `gh secret set CLOUDFLARE_ACCOUNT_ID` — from the dashboard URL
4. Actions tab -> harvest -> Run workflow, and watch the first run

If the first run 403s on kunmanga, the runner's datacenter IP is being refused;
that is the one thing a home connection has that GitHub does not.
