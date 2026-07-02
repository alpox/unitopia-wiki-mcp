import { readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { config } from "./config.js";

/** One page in the knowledge bundle, captured at index-build time. */
export interface CatalogEntry {
  conceptId: string;
  title: string;
  description: string;
  url: string;
  namespace: number;
  type: string;
  tags: string[];
  /** For redirect pages: the conceptId they point at. */
  redirectTo?: string;
  /** Outbound bundle links (conceptIds) — the page's 1-hop neighbours. */
  links?: string[];
}

/** Serialized catalog written next to the vector index. */
export interface Catalog {
  pages: CatalogEntry[];
  /** category name (no namespace prefix) → member conceptIds. */
  categories: Record<string, string[]>;
}

const RESERVED = new Set(["index.md", "log.md"]);
const CATALOG_FILE = "catalog.json";

function catalogPath(): string {
  return path.join(config.indexDir, CATALOG_FILE);
}

/** Normalize a title/term for case-insensitive lookup and query matching. */
function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Natural-language aliases for a slash-structured category name. German wikis
 * write compound categories as paths ("Rätsel/Pflicht") while users type the
 * compound word ("Pflichträtsel"). We reverse the leading pair into a compound
 * and, for deeper paths, also offer the region-qualified forms.
 *   "Rätsel/Pflicht"          → ["Pflichträtsel"]
 *   "Rätsel/Pflicht/Campus"   → ["Pflichträtsel Campus", "Campus Pflichträtsel"]
 */
export function compoundAliases(name: string): string[] {
  const parts = name.split("/").map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return [];
  const compound = parts[1] + parts[0]; // PflichtRätsel
  if (parts.length === 2) return [compound];
  const rest = parts.slice(2).join(" ");
  return [`${compound} ${rest}`, `${rest} ${compound}`];
}

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

/**
 * Detect a MediaWiki redirect body and return the target conceptId, if any.
 * Handles both "Weiterleitung nach: [X](/x.md)" and the "#WEITERLEITUNG …"
 * form, which the batched renderer turns into "1. WEITERLEITUNG [X](/x.md)".
 */
function redirectTarget(body: string): string | undefined {
  const head = body.slice(0, 120);
  if (!/(weiterleitung|redirect)/i.test(head)) return undefined;
  const m = /\]\(\/([^)\s#]+?)\.md/.exec(head);
  return m?.[1] ? decodeURIComponent(m[1]) : undefined;
}

/** Extract outbound bundle-relative links (conceptIds) from a markdown body. */
function outboundLinks(body: string, self: string, max = 40): string[] {
  const out = new Set<string>();
  const re = /\]\(\/([^)\s#]+?)\.md/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const id = decodeURIComponent(m[1]);
    if (id !== self) out.add(id);
    if (out.size >= max) break;
  }
  return [...out];
}

/**
 * Walk the OKF bundle and return the page catalog + category index. Cheap: reads
 * frontmatter + a slice of each body. Does not touch disk, so it doubles as the
 * startup builder for the offline/embedded mode (no prebuilt catalog.json).
 */
export async function computeCatalog(): Promise<Catalog> {
  const root = path.resolve(config.kbDir);
  const files = await collectMd(root);
  const pages: CatalogEntry[] = [];
  const categories: Record<string, string[]> = {};

  for (const file of files) {
    const { data: fm, content } = matter(await readFile(file, "utf8"));
    const conceptId = path
      .relative(root, file)
      .replace(/\.md$/, "")
      .split(path.sep)
      .join("/");
    const tags = Array.isArray(fm.tags) ? (fm.tags as string[]) : [];
    const entry: CatalogEntry = {
      conceptId,
      title: (fm.title as string) ?? path.basename(file, ".md"),
      description: (fm.description as string) ?? "",
      url: (fm.resource as string) ?? "",
      namespace: typeof fm.namespace === "number" ? fm.namespace : 0,
      type: (fm.type as string) ?? "Wiki Article",
      tags,
      redirectTo: redirectTarget(content.trim()),
      links: outboundLinks(content, conceptId),
    };
    pages.push(entry);
    for (const t of tags) (categories[t] ??= []).push(conceptId);
  }

  return { pages, categories };
}

/** Compute the catalog and persist it as `catalog.json` next to the index. */
export async function buildCatalog(): Promise<Catalog> {
  const catalog = await computeCatalog();
  await writeFile(catalogPath(), JSON.stringify(catalog));
  console.log(
    `[catalog] ${catalog.pages.length} pages, ${Object.keys(catalog.categories).length} categories → ${catalogPath()}`,
  );
  return catalog;
}

/** Build the in-memory catalog index directly from the KB (no catalog.json). */
export async function buildCatalogInMemory(): Promise<CatalogIndex> {
  return new CatalogIndex(await computeCatalog());
}

/** In-memory catalog with lookup structures, loaded at server start. */
export class CatalogIndex {
  private byConceptId = new Map<string, CatalogEntry>();
  /** normalized title → entry (redirects resolved to their target). */
  private byTitle = new Map<string, CatalogEntry>();
  private categories: Record<string, string[]>;
  /** normalized titles (len ≥ 4), longest first, for query scanning. */
  private candidates: { norm: string; entry: CatalogEntry }[] = [];
  /** normalized category names (len ≥ 4), longest first, for query scanning. */
  private catCandidates: { norm: string; name: string }[] = [];
  /** semantic category index: name → unit-normalized embedding (Part B). */
  private catVecs: { name: string; vec: Float32Array; nrm: number }[] = [];

  constructor(catalog: Catalog) {
    this.categories = catalog.categories;
    for (const p of catalog.pages) this.byConceptId.set(p.conceptId, p);
    for (const p of catalog.pages) {
      const target = p.redirectTo
        ? this.byConceptId.get(p.redirectTo) ?? p
        : p;
      this.byTitle.set(norm(p.title), target); // aliases resolve to target
    }
    // Compound-word pages/redirects ("Pflichträtsel") should resolve to the
    // structured sub-category page ("Kategorie:Rätsel/Pflicht"), not the broad
    // parent ("Kategorie:Rätsel") — otherwise a list query floods with all
    // members of the parent. Map category-page entries by their compound alias.
    const catPageByAlias = new Map<string, CatalogEntry>();
    for (const p of catalog.pages) {
      if (p.namespace !== 14) continue;
      const name = p.title.replace(/^[^:]+:/, "");
      for (const alias of compoundAliases(name)) catPageByAlias.set(norm(alias), p);
    }
    for (const p of catalog.pages) {
      if (!p.redirectTo) continue;
      const cat = catPageByAlias.get(norm(p.title));
      if (cat) this.byTitle.set(norm(p.title), cat);
    }
    this.candidates = [...this.byTitle.entries()]
      .filter(([t]) => t.length >= 4)
      .map(([t, entry]) => ({ norm: t, entry }))
      .sort((a, b) => b.norm.length - a.norm.length);
    const catForms = new Map<string, string>(); // alias norm → category name
    for (const name of Object.keys(this.categories)) {
      for (const form of [name, ...compoundAliases(name)]) {
        const n = norm(form);
        if (n.length >= 4 && !catForms.has(n)) catForms.set(n, name);
      }
    }
    this.catCandidates = [...catForms.entries()]
      .map(([n, name]) => ({ norm: n, name }))
      .sort((a, b) => b.norm.length - a.norm.length);
  }

  get size(): number {
    return this.byConceptId.size;
  }

  getByConceptId(conceptId: string): CatalogEntry | undefined {
    return this.byConceptId.get(conceptId);
  }

  /**
   * Find up to `max` catalog pages whose title appears (as a whole-word match)
   * in the query — longest titles first, non-overlapping. Redirects resolved.
   */
  resolveTitlesInQuery(query: string, max = 3): CatalogEntry[] {
    const q = norm(query);
    const hits: CatalogEntry[] = [];
    const taken: [number, number][] = [];
    const seen = new Set<string>();
    for (const { norm: t, entry } of this.candidates) {
      if (hits.length >= max) break;
      let from = 0;
      while (true) {
        const i = q.indexOf(t, from);
        if (i < 0) break;
        const before = i === 0 ? " " : q[i - 1];
        const after = i + t.length >= q.length ? " " : q[i + t.length];
        const boundary = /[^\p{L}\p{N}]/u.test(before) && /[^\p{L}\p{N}]/u.test(after);
        const overlaps = taken.some(([s, e]) => i < e && i + t.length > s);
        if (boundary && !overlaps) {
          if (!seen.has(entry.conceptId)) {
            hits.push(entry);
            seen.add(entry.conceptId);
          }
          taken.push([i, i + t.length]);
          break;
        }
        from = i + 1;
      }
    }
    return hits;
  }

  /**
   * Find category names mentioned in the query (whole-word, longest first) and
   * return them with their member conceptIds — powers "list all <category>".
   */
  resolveCategoriesInQuery(query: string, max = 2): { name: string; members: string[] }[] {
    const q = norm(query);
    const hits: { name: string; members: string[] }[] = [];
    const seenNames = new Set<string>();
    for (const { norm: t, name } of this.catCandidates) {
      if (hits.length >= max) break;
      if (seenNames.has(name)) continue;
      const i = q.indexOf(t);
      if (i < 0) continue;
      const before = i === 0 ? " " : q[i - 1];
      const after = i + t.length >= q.length ? " " : q[i + t.length];
      if (/[^\p{L}\p{N}]/u.test(before) && /[^\p{L}\p{N}]/u.test(after)) {
        seenNames.add(name);
        hits.push({ name, members: this.categories[name] ?? [] });
      }
    }
    return hits;
  }

  /** Names of all categories (used to build the semantic index). */
  categoryNames(): string[] {
    return Object.keys(this.categories);
  }

  /** A sample of a category's content-page member titles (for embedding). */
  categoryMemberTitles(name: string, max = 20): string[] {
    const out: string[] = [];
    for (const id of this.categories[name] ?? []) {
      const e = this.byConceptId.get(id);
      if (e && e.namespace !== 14) out.push(e.title);
      if (out.length >= max) break;
    }
    return out;
  }

  /** Attach the semantic category index (embeddings of category names). */
  attachCategoryVectors(entries: { name: string; vec: number[] }[]): void {
    this.catVecs = entries.map(({ name, vec }) => {
      const f = Float32Array.from(vec);
      let s = 0;
      for (const x of f) s += x * x;
      return { name, vec: f, nrm: Math.sqrt(s) || 1 };
    });
  }

  get semanticReady(): boolean {
    return this.catVecs.length > 0;
  }

  /**
   * Semantic category lookup (Part B): cosine-nearest category names to a
   * pre-embedded query vector. Returns names + members above `minScore`.
   */
  nearestCategories(queryVec: number[], k = 2, minScore = 0.62): { name: string; members: string[]; score: number }[] {
    if (!this.catVecs.length) return [];
    const q = Float32Array.from(queryVec);
    let qn = 0;
    for (const x of q) qn += x * x;
    qn = Math.sqrt(qn) || 1;
    const scored: { name: string; score: number }[] = [];
    for (const { name, vec, nrm } of this.catVecs) {
      const n = Math.min(vec.length, q.length);
      let dot = 0;
      for (let i = 0; i < n; i++) dot += vec[i] * q[i];
      scored.push({ name, score: dot / (nrm * qn) });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored
      .filter((s) => s.score >= minScore)
      .slice(0, k)
      .map((s) => ({ name: s.name, members: this.categories[s.name] ?? [], score: s.score }));
  }

  /** Content-page members (excludes sub-categories) of a category page. */
  categoryMembers(entry: CatalogEntry): string[] {
    if (entry.namespace !== 14) return [];
    const name = entry.title.replace(/^[^:]+:/, "");
    return (this.categories[name] ?? []).filter(
      (id) => this.byConceptId.get(id)?.namespace !== 14,
    );
  }

  /** True for a disambiguation / "Sammelseite" (subpage hub) page. */
  isDisambiguation(entry: CatalogEntry): boolean {
    return entry.tags.includes("Subpages");
  }

  /** 1-hop outbound neighbours (linked pages) of an entry. */
  neighbors(entry: CatalogEntry): CatalogEntry[] {
    const out: CatalogEntry[] = [];
    for (const id of entry.links ?? []) {
      const e = this.byConceptId.get(id);
      if (e) out.push(e);
    }
    return out;
  }

  /** Concrete subpages of a hub page, e.g. "Baldrian" → "Baldrian/Tadmor". */
  variantsOf(entry: CatalogEntry, max = 8): CatalogEntry[] {
    const prefix = norm(entry.title) + "/";
    const out: CatalogEntry[] = [];
    for (const e of this.byConceptId.values()) {
      if (norm(e.title).startsWith(prefix)) out.push(e);
      if (out.length >= max) break;
    }
    return out;
  }
}

/** Load `catalog.json` if present; returns null when not yet built. */
export async function loadCatalog(): Promise<CatalogIndex | null> {
  if (!existsSync(catalogPath())) return null;
  try {
    const cat = JSON.parse(await readFile(catalogPath(), "utf8")) as Catalog;
    return new CatalogIndex(cat);
  } catch {
    return null;
  }
}

/** Read a page's markdown body (frontmatter + citations stripped, truncated). */
export async function readPageBody(
  conceptId: string,
  maxChars = 1800,
): Promise<string> {
  const file = path.join(path.resolve(config.kbDir), `${conceptId}.md`);
  if (!existsSync(file)) return "";
  const { content } = matter(await readFile(file, "utf8"));
  const body = content.replace(/\n#\s+Citations[\s\S]*$/i, "").trim();
  return body.length > maxChars ? body.slice(0, maxChars) + "\n…" : body;
}
