/** Standalone entry (`npm run crawl:marcopolo [-- --region Vaniorh --limit 50]`):
 *  crawl marcopolo.copete.de map pages into OKF documents under `_marcopolo/`. */
import path from "node:path";
import { config } from "../config.js";
import { crawlMarcopolo } from "./marcopolo.js";

function argOf(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const region = argOf("region");
  const limit = argOf("limit") ? Number(argOf("limit")) : undefined;
  const bundleDir = path.resolve(config.kbDir);
  console.log(`[marcopolo] crawling${region ? ` region=${region}` : " all regions"}${limit ? ` limit=${limit}` : ""} → ${bundleDir}/_marcopolo`);
  const { written, visited } = await crawlMarcopolo({
    bundleDir,
    region,
    limit,
    log: (m) => console.log(m),
  });
  console.log(`[marcopolo] done: ${written} maps written, ${visited} pages visited`);
}

main().catch((err) => {
  console.error("[marcopolo] failed:", err);
  process.exit(1);
});
