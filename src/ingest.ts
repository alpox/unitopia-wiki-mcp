import { buildIndex, indexExists } from "./vectorstore.js";
import { buildCatalog } from "./catalog.js";
import { buildCategoryVectors } from "./catVectors.js";
import { buildNavIndex } from "./nav/navIndex.js";
import { config } from "./config.js";

/**
 * Build (or rebuild) the Unitopia OKF vector index plus the page catalog /
 * category index. Run `npm run crawl` first to populate/update the bundle.
 * Pass --if-missing to skip building when an index already exists
 * (used for automatic build on container start).
 */
async function main() {
  const ifMissing = process.argv.includes("--if-missing");
  if (ifMissing && indexExists()) {
    console.log("[ingest] index already exists, skipping (--if-missing).");
    return;
  }
  // The vector index and semantic category vectors need an embedding backend.
  // In BM25-only mode (EMBED_BACKEND=none — the stdio-MCP default) skip them and
  // rebuild just the lexical catalog + nav index the MCP loads from index/.
  if (config.embedBackend !== "none") {
    await buildIndex();
    await buildCategoryVectors();
  } else {
    console.log("[ingest] EMBED_BACKEND=none — BM25 mode: rebuilding catalog + nav only (no vector index).");
  }
  await buildCatalog();
  await buildNavIndex();
}

main().catch((err) => {
  console.error("[ingest] failed:", err);
  process.exit(1);
});
