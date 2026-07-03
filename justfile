# Unitopia wiki knowledgebase — common tasks.
# Run `just` to list recipes. Requires: just, node/npm (host), docker compose.

# Extra args forwarded to the crawler, e.g. `just crawl "--namespace 0 --limit 50"`.
crawl_args := ""

# Show available recipes.
default:
    @just --list

# 1. Update pages: crawl the wiki into the OKF bundle (host; incremental).
crawl:
    npm run crawl -- {{crawl_args}}

# Force a complete re-crawl of every page (ignores the manifest).
crawl-full:
    npm run crawl -- --full {{crawl_args}}

# Backfill "## Kenndaten" (template stats) into an existing bundle (network-free).
enrich:
    npm run enrich

# 2. Update index: incrementally re-embed changed pages and reload the server.
reindex:
    docker compose exec -T -e NODE_OPTIONS=--max-old-space-size=4096 rag node dist/ingest.js
    docker compose restart rag

# Force a full re-embed from scratch (ignores the reuse cache).
reindex-full:
    docker compose exec -T -e INGEST_FULL=1 -e NODE_OPTIONS=--max-old-space-size=4096 rag node dist/ingest.js
    docker compose restart rag

# Repackage the shipped KB archive data/unitopia-kb.tar.gz (what the MCP install extracts).
data:
    npm run build:data

# Compile TypeScript sources to dist/ (what the stdio MCP runs).
build:
    npm run build

# Rebuild everything the stdio MCP serves, on the host — no docker, no embeddings
# (BM25 mode): recompile dist/, repackage the shipped KB archive, and rebuild the
# catalog + nav index it loads from index/. Restart the MCP afterwards.
reindex-mcp: build data
    EMBED_BACKEND=none node dist/ingest.js

# Pull the latest wiki pages, then rebuild the shipped bundle. Commit+push data/ after.
update: crawl data

# Like `update`, but also rebuild the docker vector index (hybrid EMBED_BACKEND=local only).
update-docker: crawl data reindex
