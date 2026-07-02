import { buildIndex, indexExists } from "./vectorstore.js";
import { buildCatalog } from "./catalog.js";
import { buildCategoryVectors } from "./catVectors.js";
import { buildNavIndex } from "./nav/navIndex.js";

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
  await buildIndex();
  await buildCatalog();
  await buildCategoryVectors();
  await buildNavIndex();
}

main().catch((err) => {
  console.error("[ingest] failed:", err);
  process.exit(1);
});
