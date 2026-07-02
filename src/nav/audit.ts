/**
 * Offline audit of the ASCII map parser over the whole KB.
 *
 *   npx tsx src/nav/audit.ts [--top=30] [--kb=<dir>] [--json]
 *
 * Builds the room graph for every map page and reports structural health
 * signals (hidden edges, water/terrain nodes wrongly wired through, isolated
 * nodes, graph fragmentation) so the crossing heuristic's real failure rate can
 * be measured instead of guessed. Read-only; touches no index, no LLM.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { diagnosePage, type PageDiagnostics } from "./mapGraph.js";
import { config } from "../config.js";

const args = process.argv.slice(2);
const opt = (name: string, def: string) =>
  (args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1]) ?? def;
const kbDir = opt("kb", config.kbDir);
const top = Number(opt("top", "30"));
const asJson = args.includes("--json");

// A page is a map candidate if it carries wire art (mirrors the parser's own
// map-line class): box-drawing corners or o--/--o connectors.
const MAP_HINT = /[┌┐└┘┼]|o--|--o/;

interface Row extends PageDiagnostics { slug: string; }

const rows: Row[] = [];
let scanned = 0, parsed = 0;
for (const file of readdirSync(kbDir)) {
  if (!file.endsWith(".md")) continue;
  const md = readFileSync(join(kbDir, file), "utf8");
  if (!MAP_HINT.test(md)) continue;
  scanned++;
  let d: PageDiagnostics | null = null;
  try { d = diagnosePage(md); } catch (e) {
    rows.push({ slug: file, groups: 0, nodes: 0, namedNodes: 0, edges: 0, hiddenEdges: 0,
      isolated: 0, components: 0, maxDegree: 0, maxDegreeName: `PARSE ERROR: ${(e as Error).message}`,
      waterThrough: [], suspicion: 1e6 });
    continue;
  }
  if (!d) continue;
  parsed++;
  rows.push({ slug: file, ...d });
}

rows.sort((a, b) => b.suspicion - a.suspicion);

if (asJson) {
  console.log(JSON.stringify({ scanned, parsed, rows }, null, 2));
  process.exit(0);
}

// Aggregate totals.
const sum = (f: (r: Row) => number) => rows.reduce((s, r) => s + f(r), 0);
console.log(`\nMap pages scanned: ${scanned}  (parsed into graphs: ${parsed})`);
console.log(`Total nodes: ${sum((r) => r.nodes)}  edges: ${sum((r) => r.edges)}`);
console.log(`Hidden edges: ${sum((r) => r.hiddenEdges)}  isolated nodes: ${sum((r) => r.isolated)}`);
console.log(`Pages with water-through misparse: ${rows.filter((r) => r.waterThrough.length).length}`);
console.log(`Pages fragmented (>1 component): ${rows.filter((r) => r.components > 1).length}\n`);

console.log(`Top ${top} most suspicious maps:\n`);
const pad = (s: string | number, n: number) => String(s).padEnd(n);
console.log(pad("slug", 40), pad("susp", 6), pad("nodes", 6), pad("edg", 5), pad("hid", 4), pad("iso", 4), pad("cmp", 4), pad("maxDeg", 7), "water-through");
for (const r of rows.slice(0, top)) {
  const water = r.waterThrough.map((w) => `${w.name}(${w.degree})`).join(", ").slice(0, 60);
  console.log(
    pad(r.slug.replace(/\.md$/, ""), 40), pad(r.suspicion, 6), pad(r.nodes, 6),
    pad(r.edges, 5), pad(r.hiddenEdges, 4), pad(r.isolated, 4), pad(r.components, 4),
    pad(`${r.maxDegree}`, 7), water,
  );
}
console.log("");
