import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { extractMcMap } from "./extract.js";
import { mcMapToOkfBody, parseMcOkf } from "./okf.js";
import { buildMcGraph } from "./graph.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => readFileSync(join(here, "__fixtures__", name), "latin1");

// Signature of a built graph: names + directed command-edges. Storage is correct
// iff parsing the OKF form yields the SAME graph as parsing the source HTML.
const sig = (g: ReturnType<typeof buildMcGraph>) =>
  JSON.stringify({
    n: g.nodes.map((x) => x.name).sort(),
    e: g.edges.map((x) => `${x.from.split("#")[1]}|${x.to.split("#")[1]}|${x.command}|${x.hint}`).sort(),
  });

for (const [file, region, slug] of [
  ["wasserfall.html", "Vaniorh", "Wasserfall"],
  ["orkberge.html", "Vaniorh", "Orkberge"],
  ["nebelgebirge.html", "Midgard", "Nebelgebirge"],
] as const) {
  test(`marcopolo OKF: ${slug} round-trips HTML→OKF→graph losslessly`, () => {
    const fromHtml = extractMcMap(fixture(file), region, slug, "src")!;
    const okf = mcMapToOkfBody(fromHtml);
    const fromOkf = parseMcOkf(okf, region, slug, "src");

    assert.equal(fromOkf.ascii, fromHtml.ascii, "ASCII grid preserved");
    assert.equal(sig(buildMcGraph(fromOkf)), sig(buildMcGraph(fromHtml)), "rebuilt graph identical");
    // The OKF body is real markdown: fenced map + a legend section.
    assert.match(okf, /```text\n[\s\S]+```/);
    assert.match(okf, /## Legende/);
  });
}
