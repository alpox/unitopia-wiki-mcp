import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { extractMcMap } from "./extract.js";

const here = dirname(fileURLToPath(import.meta.url));
// Fixtures are the raw windows-1252 bytes as saved from the site; decode as
// latin1 (matches the crawler's decode path for the umlaut range we care about).
const fixture = (name: string) => readFileSync(join(here, "__fixtures__", name), "latin1");

test("marcopolo: Wasserfall map reconstructs ASCII, links and legend", () => {
  const m = extractMcMap(fixture("wasserfall.html"), "Vaniorh", "Wasserfall", "u");
  assert.ok(m, "map extracted");
  assert.equal(m!.title, "Bach & Wasserfall");

  // Spacing-faithful rows: the `<`/`>` came from &lt;/&gt; and must survive.
  const rows = m!.ascii.split("\n");
  assert.ok(rows.some((r) => r.includes("b-b-W..>..>..>..P")), "Bach→Plateau current row");
  assert.ok(rows.some((r) => r.includes("k<B-f-B") && r.includes(">D-L-H")), "climb/lager row intact");

  // Hyperlinked labels resolve to their target page basenames.
  const linkPages = new Set(m!.cellLinks.map((l) => l.page));
  for (const p of ["Orkberge", "Drachenkopf", "Orkhoehlen"]) assert.ok(linkPages.has(p), `cell link to ${p}`);

  // Legend: names, cross-page links and climb hints. Legend is keyed by
  // (label, colour); `b`/`P` are single-colour here so a label lookup suffices.
  const leg = (label: string) => m!.legend.find((e) => e.label === label)!;
  assert.match(leg("b").desc, /Bach/);
  assert.deepEqual(leg("P").pages, ["Orkberge"]);
  assert.ok(leg("b").climbHints.includes("^"), "Bach has an up-climb hint");
  assert.ok(m!.crossPages.includes("Borsippa_Ebene"), "legend-only cross page captured");
});

test("marcopolo: the whole-region overworld (Vaniorh.html) is readable", () => {
  const m = extractMcMap(fixture("vaniorh-region.html"), "Vaniorh", "Vaniorh", "u");
  assert.ok(m, "region overworld extracted");
  assert.equal(m!.title, "Vaniorh");
  // A big tile map — many rows — with embedded place-name gateway links.
  assert.ok(m!.ascii.split("\n").length > 30, "large overworld grid");
  const pages = new Set(m!.crossPages);
  for (const p of ["Borsippa", "Tadmor", "Orkberge", "Handelsweg"])
    assert.ok(pages.has(p), `overworld gateway link to ${p}`);

  // Overworld pages keep the map AND legend inside the one <td> (the legend is
  // NOT after </table>); splitCell must still find it, so it isn't lost and its
  // rows aren't mistaken for map art. Colour disambiguates same-letter rooms.
  assert.ok(m!.legend.length > 10, "overworld in-cell legend extracted");
  assert.equal(new Set(m!.legend.filter((e) => e.label === "D").map((e) => e.color)).size, 2, "D split by colour (Dijala vs …)");
});

test("marcopolo: Orkberge map captures the Handelsweg junction links", () => {
  const m = extractMcMap(fixture("orkberge.html"), "Vaniorh", "Orkberge", "u");
  assert.ok(m);
  const linkPages = new Set(m!.cellLinks.map((l) => l.page));
  for (const p of ["Borsippa", "Steinbruch", "Orkwald", "Tadmor", "Buchenwald", "Wasserfall"])
    assert.ok(linkPages.has(p), `junction link to ${p}`);
  // The long chain where the trade road comes together survives verbatim.
  assert.ok(m!.ascii.split("\n").some((r) => r.includes("w-F-F-F-W-W-L-W-w-w-T")), "trade-road chain row");

  // Colour disambiguation: the same letter drawn in different colours is a
  // different room. `W` appears in three colours, and only the cyan one is the
  // "runter zum Wasserfall" climb; `L` splits into Lawinen vs Sandbank.
  const cols = (label: string) => new Set(m!.legend.filter((e) => e.label === label).map((e) => e.color));
  assert.equal(cols("W").size, 3, "W has three distinct rooms by colour");
  const wCyan = m!.legend.find((e) => e.label === "W" && e.color === "00CCFF");
  assert.match(wCyan!.desc, /runter zum Wasserfall/, "cyan W is the Wasserfall climb");
  assert.equal(cols("L").size, 2, "L splits into Lawinen and Sandbank");
  // The top L cell (row 3) is the cyan Lawinen room, carried as a per-cell colour.
  assert.ok(m!.cellColors.some((c) => c.row === 3 && c.color === "00CCFF"), "top L cell tagged cyan");
});
