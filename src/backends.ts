import { loadCatalog, buildCatalogInMemory, type CatalogIndex } from "./catalog.js";
import { loadNavIndex, buildNavInMemory, type NavIndex } from "./nav/navIndex.js";
import { loadOkfDocuments } from "./loadDocuments.js";
import { HybridSearch } from "./hybrid.js";
import { config } from "./config.js";
import type { HNSWLib } from "@langchain/community/vectorstores/hnswlib";

/**
 * The backing indices every entry point (the OpenAI-compatible server and the
 * MCP server) needs. `store` is null in BM25-only mode (`EMBED_BACKEND=none`,
 * the default), where retrieval is pure lexical and nothing native is loaded.
 * `catalog` and `nav` are always available — loaded from prebuilt JSON when
 * present, otherwise built in memory from the KB.
 */
export interface Backends {
  store: HNSWLib | null;
  catalog: CatalogIndex | null;
  nav: NavIndex | null;
  hybrid: HybridSearch;
}

/**
 * Canonical bootstrap, shared so the OpenAI server and the MCP server load
 * indices identically and can never drift. Logs go to stderr so they don't
 * corrupt an MCP stdio stream.
 *
 * Default (`EMBED_BACKEND=none`): BM25-only over the KB, no vector index, no
 * embedding model, no native `hnswlib-node` — fully offline, pure JS. The dense
 * vector path (`local`/`ollama`) is loaded lazily so it never touches the
 * offline install; it powers the richer hybrid retrieval in the docker stack.
 */
export async function initBackends(): Promise<Backends> {
  const log = (m: string) => console.error(m);

  const docs = await loadOkfDocuments();

  let store: HNSWLib | null = null;
  if (config.embedBackend !== "none") {
    log(`[backends] embedding backend '${config.embedBackend}' — loading vector index`);
    const { loadIndex } = await import("./vectorstore.js");
    store = await loadIndex();
  }

  // Catalog: prebuilt JSON (docker) or built in memory from the KB (embedded).
  const catalog = (await loadCatalog()) ?? (await buildCatalogInMemory());
  log(`[backends] catalog ready (${catalog.size} pages, exact-title + category lookup)`);
  if (store) {
    const { loadCategoryVectors } = await import("./catVectors.js");
    const catVecs = await loadCategoryVectors();
    if (catVecs) {
      catalog.attachCategoryVectors(catVecs);
      log(`[backends] semantic category index loaded (${catVecs.length} category embeddings)`);
    }
  }

  // Nav: prebuilt JSON (docker) or built in memory from the KB (embedded).
  const nav = (await loadNavIndex()) ?? (await buildNavInMemory());
  log(`[backends] nav index ready (${nav.size} map rooms, deterministic routing)`);

  const hybrid = new HybridSearch(docs, store);
  log(
    `[backends] ${hybrid.hybrid ? "hybrid (BM25 + vector, RRF-fused)" : "BM25-only"} retrieval ready over ${hybrid.size} chunks`,
  );

  return { store, catalog, nav, hybrid };
}
