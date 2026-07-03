/** Standalone entry (`npm run crawl:gridmaps`): (re)build the overworld grid-map
 *  artifacts from the already-crawled Kachelkarte wikitext, without a full crawl. */
import path from "node:path";
import { config } from "../config.js";
import { discover } from "./mediaWikiClient.js";
import { buildGridMaps } from "./gridMaps.js";

async function main() {
  const site = await discover();
  await buildGridMaps(path.resolve(config.kbDir), site);
}

main().catch((err) => {
  console.error("[grid] failed:", err);
  process.exit(1);
});
