# Unitopia Wiki MCP + RAG server

A TypeScript service over an archived copy of the **Unitopia MUD wiki**
(http://unitopia.intelligense.de), stored as a **Google OKF v0.1** knowledge bundle. It exposes the
knowledgebase two ways:

- an **MCP server** (`search`, `fetch`, `map`, `route`, `list_category`) for Claude Code / ChatGPT /
  Gemini — **pure JS, no native deps, no ollama, no model, no internet at run time**;
- an **OpenAI-compatible RAG API** (LangGraph + a local **qwen3** in ollama) for use behind **Qwen Code**
  (optional, via docker).

## Install as a Claude Code MCP (one command)

```bash
claude mcp add unitopia-kb -- npx -y github:alpox/unitopia-wiki-mcp
```

That's the whole install — the standard MCP registration command. The only requirement on the machine
is **Node ≥ 18** (which Claude Code already needs); there is nothing else to install, nothing to build
by hand, and no data to download. Run `/mcp` in Claude Code to confirm `unitopia-kb` is connected.

**How it stays this small & offline.** Retrieval is **BM25** (a lexical inverted index) built in
memory from the wiki text at startup — so there is no 300 MB vector index, no embedding model, and no
native `hnswlib` addon to compile. The wiki text ships **compressed in the package** (`data/unitopia-kb.tar.gz`,
~12 MB) and is extracted once on first launch into `~/.local/share/unitopia-wiki-mcp`. The **semantic
reasoning is supplied by the client LLM** (Claude): it reformulates queries, tries synonyms, and reasons
over the returned pages — which for a domain of proper nouns (NPCs, items, areas) is where lexical match
is already strongest.

Overrides: `KB_DIR` (use an existing KB tree instead of the bundled one),
`UNITOPIA_MCP_DATA` / `XDG_DATA_HOME` (where the KB is extracted).
Add `--scope user` to the command to register it for every project (default is project scope).

### Updating the shipped wiki (maintainer)

The runtime KB is shipped as `data/unitopia-kb.tar.gz` (tracked in git); the raw `knowledgebase/` tree
is git-ignored. One command pulls the latest pages from the online wiki and rebuilds the bundle:

```bash
just update               # = crawl (incremental) + build:data → data/unitopia-kb.tar.gz
git commit -am "Update KB" && git push
```

`just update` runs an **incremental** crawl (only pages whose wiki revision changed) and repacks the
archive (excluding the `_wikitext` backups). After you commit + push, the `npx` install serves the
fresh content on its next launch. (`just crawl-full` forces a complete re-crawl; `just update-docker`
also rebuilds the docker vector index for the hybrid stack.)

## Architecture

```
Unitopia MediaWiki ──crawler (api.php)──▶  knowledgebase/unitopia/  (OKF bundle → data/*.tar.gz)
                                                │
Claude Code ──MCP (stdio)──▶ mcp server ──▶ retrieve (BM25, in-memory)   ◀── default: pure JS, offline
                                                │
Qwen Code ──OpenAI /v1/chat/completions──▶  rag-server (Express)          ◀── optional (docker + ollama)
                                                │
                                                ▼
                                          LangGraph app
                                     ┌──────────┴──────────┐
                                     ▼                     ▼
                              retrieve (BM25 [+ vector    generate (ChatOllama
                              when EMBED_BACKEND≠none])     qwen3)
                                     │                     │
                                     └─────► ollama ◄──────┘
```

- **`src/crawler/`** — a deterministic MediaWiki crawler tuned for speed (full wiki in a few minutes):
  - **Pass 1 (bulk)**: `generator=allpages&prop=revisions|info|categories` pulls wikitext + revid +
    timestamp + categories **50 pages/request** as JSON.
  - **Pass 2 (batched render)**: ~50 pages' wikitext are concatenated with nonce sentinels and rendered
    in a single `action=parse&text=` POST (templates fully expanded server-side), then the HTML is split
    back per page and converted to markdown (turndown) with internal links rewritten to bundle-relative
    OKF links. Runs with a small concurrency pool.
  - Pages relying on `{{PAGENAME}}` are auto-detected and re-rendered individually (correct title context).
  - **Idempotent & incremental**: `.okf-crawl-state.json` tracks revid + content hash; re-runs only
    re-render pages whose revid changed and detect deletions. Each page's raw wikitext is also saved under
    `_wikitext/` as a re-importable backup.
  - A *normal* (non-AI) crawler is the right tool here because MediaWiki's API is fully structured.
  - `--render=server-single` forces the slower 1-request/page path (for fidelity comparison/debugging).
- **`src/loadDocuments.ts`** — walks the OKF bundle, parses frontmatter (`gray-matter`), and emits one
  LangChain `Document` per markdown section with wiki provenance metadata (`title`, `url`, `tags`, …).
- **`src/hybrid.ts`** — retrieval. **BM25** (a pure-JS inverted index) is always built in memory from
  the wiki chunks at startup; with `EMBED_BACKEND≠none` a dense vector index is fused in via Reciprocal
  Rank Fusion. The default (`none`) is BM25-only — no model, no index, no native deps.
- **`src/vectorstore.ts`** *(hybrid mode only)* — embeds documents into a persisted **HNSWLib** index
  (`INDEX_DIR`). **Incremental**: re-ingest reuses stored embeddings for unchanged chunks (keyed by
  chunk-content hash) and only embeds new/changed ones. Loaded lazily, so the BM25-only path never
  touches the native `hnswlib-node` addon. Set `INGEST_FULL=1` to force a full re-embed.
- **`src/catalog.ts`** — builds a page catalog + category index. Prebuilt as `catalog.json` during
  `ingest` (docker), or built **in memory** from the KB at startup (embedded mode). Powers **exact-title
  lookup** (a named page is injected whole) and **category pages** (their member list is included).
  Redirect pages resolve to their target.
- **`src/graph.ts`** — a LangGraph `StateGraph` with `retrieve → generate` nodes and a specialized
  German "Unitopia-Experte" system prompt grounded in the retrieved wiki context.
- **`src/server.ts`** — OpenAI-compatible endpoints (`/v1/models`, `/v1/chat/completions`, streaming).

## Crawl the wiki

```bash
npm install
just update               # incremental crawl into knowledgebase/unitopia + repackage the bundle
# npm run crawl           # just the crawl (no repackage)
# npm run crawl:full      # force a complete re-crawl
# node dist/crawler/index.js --namespace 0 --limit 50   # sample a subset
```

Re-running `npm run crawl` later only fetches pages whose revision changed upstream and appends the
changes to `log.md`, keeping git diffs minimal.

## Run the full RAG stack with Docker (optional)

The docker stack runs the OpenAI-compatible RAG server (for Qwen Code) in **hybrid** mode
(`EMBED_BACKEND=local`, set in the `Dockerfile`). `docker-compose.yml` lives at the repo root and
mounts `./knowledgebase` into the containers, so a fresh clone must first materialize the KB from the
shipped bundle (it is git-ignored):

```bash
mkdir -p knowledgebase && tar -xzf data/unitopia-kb.tar.gz -C knowledgebase   # → knowledgebase/unitopia
docker compose up -d --build
```

The first start embeds the knowledge bundle with the in-process ONNX model (`Xenova/multilingual-e5-base`,
fetched once from HuggingFace) and persists the index to the `rag-index` volume (subsequent starts
reuse it). The API is then on `http://localhost:8080/v1`.

Rebuild the index after a fresh crawl:

```bash
docker compose run --rm rag node dist/ingest.js
```

## Run on the host (for development)

```bash
cd rag-server
npm install
# The MCP server (BM25, no index needed):
npm run mcp:stdio:dev
# Or the OpenAI-compatible RAG server on :8080 (needs ollama; add EMBED_BACKEND=local
# + `npm run ingest` first if you want hybrid retrieval):
npm run dev
```

The KB must be present at `knowledgebase/unitopia` (extract `data/unitopia-kb.tar.gz`, or run
`npm run crawl`). `npm run ingest` is only needed for the `local`/`ollama` hybrid backends.

## Smoke test

```bash
curl -s localhost:8080/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"qwen3-unitopia-rag","messages":[
        {"role":"user","content":"Was kann man mit dem Spiel 7 Türme tun und wo bekommt man es?"}]}' \
  | python3 -m json.tool
```

## Use with Qwen Code

See [QWEN_CODE.md](./QWEN_CODE.md).

## Retrieval backends

`EMBED_BACKEND` selects how `search` retrieves:

- **`none`** (default) — **BM25 only**. Pure JS, no model, no vector index, no native deps, fully
  offline. This is what the `npx` MCP install uses. `hnswlib-node` and `@huggingface/transformers` are
  `optionalDependencies`, so a machine without a C++ toolchain installs fine (the native build simply
  fails and is skipped — BM25 never needs it).
- **`local`** — hybrid: fuse BM25 with dense vectors from an in-process ONNX model
  (`LOCAL_EMBED_MODEL`, default `Xenova/multilingual-e5-base`), fetched once from HuggingFace and cached.
- **`ollama`** — hybrid, embedding via the ollama-hosted `EMBED_MODEL`.

The docker image pins `EMBED_BACKEND=local` (see `Dockerfile`) so the RAG server keeps hybrid retrieval.
For `local`/`ollama` you need a prebuilt index (`npm run ingest`), built with the **same** backend/model
that queries it, or vectors won't match.

`INDEX_DIR` and `KB_DIR` default to package-relative paths so the server runs from any working directory;
both are overridable (docker/monorepo set them explicitly).

## Configuration

All settings are environment variables (see `.env.example` / `src/config.ts`): `EMBED_BACKEND`,
`OLLAMA_BASE_URL`, `CHAT_MODEL`, `LOCAL_EMBED_MODEL`, `EMBED_MODEL`, `PORT`, `MCP_PORT`, `TOP_K`,
`INDEX_DIR`, `KB_DIR`, `WIKI_BASE_URL`, `SERVED_MODEL_ID`, `THINK`, `MAX_HISTORY_MESSAGES`,
`MAX_QUERY_CHARS`. Crawler tuning: `CRAWL_DELAY_MS` (delay between bulk-enumeration requests),
`CRAWL_BATCH_SIZE` (pages per render call, default 50), `CRAWL_CONCURRENCY` (parallel render requests,
default 4).
