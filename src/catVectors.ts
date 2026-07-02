import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { makeEmbeddings, embedModelName } from "./embeddings.js";
import { compoundAliases, loadCatalog } from "./catalog.js";

/**
 * Semantic category index (Part B). We embed every category name — together
 * with its natural-language compound aliases — so a free-text question can be
 * matched to a category by meaning, not just substring. Stored next to the
 * vector index as `catvecs.json` and rebuilt at ingest time.
 */
const CATVECS_FILE = "catvecs.json";
const catVecsPath = () => path.join(config.indexDir, CATVECS_FILE);

interface CatVecs {
  model: string;
  entries: { name: string; vec: number[] }[];
}

/** A readable phrase per category: path parts spaced + compound aliases +
 *  a sample of member titles, which gives the embedder real content to match
 *  against (bare category names alone are too sparse to discriminate). */
function embedText(name: string, members: string[]): string {
  const spaced = name.split("/").join(" ");
  const head = [spaced, ...compoundAliases(name)].join(". ");
  return members.length ? `${head}. Enthält: ${members.join(", ")}` : head;
}

export async function buildCategoryVectors(): Promise<void> {
  const catalog = await loadCatalog();
  if (!catalog) {
    console.log("[catvecs] no catalog.json — skipping semantic category index.");
    return;
  }
  // Restrict the semantic index to user-facing, top-level content categories:
  // they aggregate all members (e.g. "Waffe" = 1013), match far more cleanly
  // than the fragmented region/type sub-categories ("Waffe/Ebenen/Munition"),
  // and exclude wiki-meta/namespace buckets that only add noise.
  const META = new Set(["Todo", "Hidden", "Subpages", "Tabs", "Spalten", "Set", "Adjektiv", "ZusatzAussehen", "Zustand", "Angebot", "Brett", "Info", "Vorlage", "Schriften"]);
  const names = catalog
    .categoryNames()
    .filter((n) => !n.includes("/") && !n.includes(":") && !META.has(n) && (catalog.categoryMemberTitles(n, 3).length > 0));
  const emb = makeEmbeddings();
  const batch = Number(process.env.EMBED_BATCH_SIZE ?? 256);
  const entries: { name: string; vec: number[] }[] = [];
  for (let i = 0; i < names.length; i += batch) {
    const slice = names.slice(i, i + batch);
    const vecs = await emb.embedDocuments(slice.map((n) => embedText(n, catalog.categoryMemberTitles(n))));
    slice.forEach((name, k) => entries.push({ name, vec: vecs[k] }));
    if (i % (batch * 10) === 0) console.log(`[catvecs] embedded ${entries.length}/${names.length}`);
  }
  const out: CatVecs = { model: embedModelName(), entries };
  await writeFile(catVecsPath(), JSON.stringify(out));
  console.log(`[catvecs] ${entries.length} category embeddings → ${catVecsPath()}`);
}

export async function loadCategoryVectors(): Promise<{ name: string; vec: number[] }[] | null> {
  if (!existsSync(catVecsPath())) return null;
  try {
    const data = JSON.parse(await readFile(catVecsPath(), "utf8")) as CatVecs;
    return data.entries;
  } catch {
    return null;
  }
}
