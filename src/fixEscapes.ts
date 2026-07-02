import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";

/**
 * One-off cleanup: turndown escaped every literal backslash as "\\", which
 * corrupts the ASCII area maps (NW/SO diagonals "\" became "\\"). Collapse
 * doubled backslashes back to single across the bundle. Network-free; new
 * crawls already emit clean maps (pre blocks render verbatim).
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
    if (!md.includes("\\\\")) continue;
    await writeFile(file, md.replace(/\\\\/g, "\\"));
    changed++;
    if (changed % 1000 === 0) console.log(`[fix-escapes] updated ${changed}...`);
  }
  console.log(`[fix-escapes] done. Fixed ${changed} of ${files.length} pages.`);
}

main().catch((err) => {
  console.error("[fix-escapes] failed:", err);
  process.exit(1);
});
