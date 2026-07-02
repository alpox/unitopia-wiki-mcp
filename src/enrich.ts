import { readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { extractKenndaten } from "./crawler/templateData.js";

/**
 * One-off, network-free enrichment of an existing OKF bundle: add a
 * "## Kenndaten" block (template stats recovered from the archived wikitext)
 * to each page that lacks one. New crawls produce this block directly; this
 * backfills bundles crawled before that change. Run `npm run ingest` afterwards.
 */
const RESERVED = new Set(["index.md", "log.md"]);

async function collectMd(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (e.name.startsWith("_")) continue;
      out.push(...(await collectMd(path.join(dir, e.name))));
    } else if (e.name.endsWith(".md") && !RESERVED.has(e.name)) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

async function main() {
  const root = path.resolve(config.kbDir);
  const files = await collectMd(root);
  let changed = 0;

  for (const file of files) {
    const md = await readFile(file, "utf8");
    if (md.includes("## Kenndaten")) continue;

    const conceptId = path.relative(root, file).replace(/\.md$/, "");
    const wikiFile = path.join(root, "_wikitext", `${conceptId}.wiki`);
    if (!existsSync(wikiFile)) continue;

    const kenndaten = extractKenndaten(await readFile(wikiFile, "utf8"));
    if (!kenndaten) continue;

    // Insert before the "# Citations" footer if present, else append.
    const ci = md.search(/\n#\s+Citations/i);
    const updated =
      ci >= 0
        ? `${md.slice(0, ci)}\n\n${kenndaten}\n${md.slice(ci)}`
        : `${md.trimEnd()}\n\n${kenndaten}\n`;
    await writeFile(file, updated);
    changed++;
    if (changed % 1000 === 0) console.log(`[enrich] updated ${changed} pages...`);
  }

  console.log(`[enrich] done. Added Kenndaten to ${changed} of ${files.length} pages.`);
}

main().catch((err) => {
  console.error("[enrich] failed:", err);
  process.exit(1);
});
