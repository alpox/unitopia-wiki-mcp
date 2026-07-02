# Map Parser — Measure-First Findings & Decision

Result of the evaluation of whether to rewrite `mapGraph.ts` around an explicit
layer model. **Short answer: a layered rewrite is not justified.** The real
top failures were map *segmentation*, not crossing/layer logic — and they're
fixed with a two-character change. Details below.

## How it was measured

- `src/nav/audit.ts` (`npm run audit:maps`) — builds the graph for every ASCII
  map page (122 of them) and ranks pages by structural-health signals
  (hidden edges, isolated nodes, graph fragmentation, water/terrain nodes wired
  through). `diagnosePage()` in `mapGraph.ts` exposes those signals.
- `src/nav/mapGraph.test.ts` (`npm test`) — golden regression tests over real KB
  pages; hand-verified routes.

## What the corpus actually contains (122 ASCII map pages)

| Crossing / layer convention | Pages | Handled? |
|---|---|---|
| Dot-flanking `.` / `'` (river under road) | 53 | Yes — the deliberate, legend-documented convention. Working. |
| `\|\/\|` diagonal weave (water texture) | 61 | Mostly fine; not a true over/under. |
| `┌┼┐` / `┘o└` bridge glyph | 1 (`drachenland.md`) | Now parses after the segmentation fix. |
| Full-image raster maps (remote `.gif`) | ~200 pages | Out of scope — not shipped in KB; needs vision. |

**Over/under is far smaller than it looks.** The dominant crossing convention
(dots) is deterministic and already correct. No visual reasoning is needed for
ASCII maps: every map carries the same explicit `Zeichenerklärung` legend.

## The real top failure: map-block segmentation

`splitGroups` decides which text rows belong to one map via `isMapLine`. Two gaps
caused it to **shatter box-drawing maps into fragments**, so a map's legend
attached to one fragment while its node markers scattered across others with no
legend — making rooms unroutable:

1. `isMapLine`'s connector test accepted only ASCII `o ~ | / \ -`, **not**
   box-drawing chars. Corner-only rows like `┌┼┐` or `┌┘ ' ˄` failed it and split
   the map.
2. `CLS` (the allowed-character class) omitted `_`, so decoration rows like
   `\_'\_` split the map.

**Burg Tregyln** (the user's worst case, in `drachenland.md`) was split into **4
fragments**; none of its 16 rooms could be routed. After the fix it is **one
36-line map**, all rooms resolve, and routes are correct (e.g. Thronsaal→Sabines
= `norden osten`, i.e. 6→Gang(7)→8 — matches the legend).

### The fix (in `mapGraph.ts`)

- Added a `WIRECH` regex that includes box-drawing glyphs; `isMapLine` uses it.
- Added `_` to `CLS`.

Two lines. No architectural change, public API untouched.

### Corpus-wide effect (audit before → after)

- Isolated nodes 523 → 512, nodes +76, edges +233 (previously-dropped rows now
  connect); parse count unchanged (117/122); `drachenland` fell off the
  top-suspicious list. No regressions.

## Known remaining limitations (not fixed here)

- **Inline-prose-label maps** (`stadtplan-massilia.md`, `mannheim.md`,
  `höhlenwelt.md`, + 2 more): use full words beside nodes (`Tempel O`) instead of
  single-char legend keys. The parser yields 0 groups for these. Different format,
  rarer — would need a separate label-association pass, not a layer model.
- **Bridge-anchor route quality** (e.g. Tadmor `Friedhof`→`Kathedrale`): a name
  that is both a room and a sub-map anchor resolves into the sub-map and produces
  a wandering route. Cosmetic pathing issue, orthogonal to layers.
- **Big multi-segment maps** (`handelsweg-terqa`, `handelsweg-borsippa`) have many
  disconnected components — mostly genuine (separate stretches), but some may be
  tracer misses. Not investigated in depth.
- Audit's "water-through" flag is a *heuristic* and over-reports (shorelines/`Ufer`
  and bridges are legitimately walkable); treat it as a lead, not a verdict.

## Cross-page routing (paths across several ASCII maps)

Routing previously only worked when both endpoints lived on the **same** page.
Sub-maps *within* a page were already bridged (via legend `#anchors`), but a trip
spanning separate pages — e.g. `tadmor` → `handelsweg-borsippa` → `borsippa` —
returned "ambiguous/none".

Added a **cross-page router** (`NavIndex.routeCrossPage`, wired as a fallback in
`resolveAndRoute`, so the MCP `route` tool gets it for free):

- **Page graph** from *reciprocal* legend gateways: page A links to B **and** B
  links back to A (`mapGraph.pageLinks` extracts the `](/page.md)` targets from
  each legend room). One-directional links — often connections that only exist on
  the big **image** maps — are skipped, per "ignore those for now". Result: 34
  pages, 66 directed edges.
- **Primary-target rule**: a gateway lists `[neighbour, …destination]` (Tadmor's
  Westtor → `[handelsweg-borsippa, borsippa]`). Only the first is a real
  adjacency; using the rest would teleport city-to-city and skip the road. So a
  route now *traverses* the intermediate road map instead of jumping over it.
- **Stitching**: BFS finds the shortest page-chain; each page's leg is routed with
  the existing single-page router and joined by a crossing step at every boundary.
  If any leg doesn't actually connect, that page-path is rejected (no fabricated
  routes).

Verified end-to-end: `Kathedrale (Tadmor)` → `Marktplatz (Borsippa)` now routes
through `handelsweg-borsippa` (crossing in at "Westtor von Tadmor", out at
Borsippa's "Oststadtor"). Regression tests in `crossPage.test.ts`.

Note: common room names ("Steg", "Thronsaal") can still be ambiguous across pages
— that's resolved by the existing LLM disambiguation layer (`routeCandidates`),
unchanged here.

## Decision

Keep the current wire-tracer. A full layered rewrite + layer index would **not**
have addressed the actual top failures (segmentation and an unsupported label
style) and would have risked the 53 dot-crossing maps that already work. If a
future need arises (e.g. systemic crossing errors the dot convention can't
express), the golden corpus in `mapGraph.test.ts` makes that rewrite safe to
attempt — scope it then, with data.
