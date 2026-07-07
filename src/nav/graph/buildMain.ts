/** Standalone entry (`npm run build:navgraph`): (re)build the unified per-region
 *  navigation graphs under `_navgraph/` from the wiki pages + crawled marcopolo
 *  maps. Runs as part of ingest, or on its own after a marcopolo crawl. */
import path from "node:path";
import { config } from "../../config.js";
import { buildRegionGraphs } from "./build.js";

buildRegionGraphs(path.resolve(config.kbDir), (m) => console.log(m)).catch((err) => {
  console.error("[navgraph] failed:", err);
  process.exit(1);
});
