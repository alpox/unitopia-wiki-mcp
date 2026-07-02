import { Document } from "@langchain/core/documents";
// Type-only: the concrete HNSWLib (and its native `hnswlib-node` addon) is loaded
// dynamically by backends.ts ONLY in an embedding mode. Keeping this a type import
// means the BM25-only path never pulls in the native dependency at run time.
import type { HNSWLib } from "@langchain/community/vectorstores/hnswlib";

/**
 * Retrieval over the wiki chunks. Sparse keyword search (BM25) is always built
 * from the documents in-process — no model, no native index. When a dense vector
 * `store` is supplied it is fused in via Reciprocal Rank Fusion; without one the
 * search is pure BM25 (the default offline/embedded mode, where the calling LLM
 * supplies the semantic reasoning).
 *
 * The wiki is full of exact in-game proper nouns (NPC names, item names, area
 * names, commands) where lexical match matters but a 768-dim embedding may blur
 * a rare token away. BM25 catches those; the optional vector side catches
 * paraphrase and semantic matches. RRF combines both rankings without needing
 * comparable score scales, so neither side has to be calibrated against the other.
 */

const STOP = new Set([
  "der", "die", "das", "dem", "den", "des", "ein", "eine", "einen", "einem", "einer",
  "und", "oder", "aber", "mit", "ohne", "von", "vom", "zum", "zur", "zu", "im", "in",
  "auf", "aus", "bei", "am", "an", "ist", "sind", "war", "wie", "was", "wer", "wo",
  "man", "ich", "du", "es", "sich", "auch", "nur", "noch", "fuer", "ueber",
  "the", "of", "and", "a", "to", "is", "for",
]);

/** Lowercase, transliterate umlauts, split into significant word tokens. */
function tokenize(s: string): string[] {
  const norm = s
    .toLowerCase()
    .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss");
  return norm.split(/[^a-z0-9]+/).filter((t) => t.length >= 2 && !STOP.has(t));
}

interface Posting { docId: number; tf: number }

export class HybridSearch {
  private docs: Document[] = [];
  private docLen: number[] = [];
  private avgLen = 0;
  private postings = new Map<string, Posting[]>();
  private df = new Map<string, number>();
  private readonly k1 = 1.5;
  private readonly b = 0.75;

  /**
   * @param documents the wiki chunks to index for BM25 (from loadOkfDocuments).
   * @param store     optional dense vector index; when given, search is hybrid.
   */
  constructor(documents: Document[], private store: HNSWLib | null = null) {
    this.indexDocuments(documents);
  }

  /** True when a dense vector index is fused in; false for BM25-only. */
  get hybrid(): boolean {
    return this.store !== null;
  }

  /** Build BM25 stats over the given chunk documents. */
  private indexDocuments(documents: Document[]): void {
    let totalLen = 0;
    for (const doc of documents) {
      const docId = this.docs.length;
      this.docs.push(doc);
      const tokens = tokenize(doc.pageContent);
      this.docLen.push(tokens.length);
      totalLen += tokens.length;
      const tf = new Map<string, number>();
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const [term, n] of tf) {
        let p = this.postings.get(term);
        if (!p) { p = []; this.postings.set(term, p); }
        p.push({ docId, tf: n });
        this.df.set(term, (this.df.get(term) ?? 0) + 1);
      }
    }
    this.avgLen = this.docs.length ? totalLen / this.docs.length : 0;
  }

  get size() { return this.docs.length; }

  /** Top-k BM25 matches as [docId, score], best first. */
  private bm25(query: string, k: number): number[] {
    const N = this.docs.length;
    if (!N) return [];
    const scores = new Map<number, number>();
    for (const term of new Set(tokenize(query))) {
      const posting = this.postings.get(term);
      if (!posting) continue;
      const df = this.df.get(term) ?? posting.length;
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      for (const { docId, tf } of posting) {
        const norm = tf * (this.k1 + 1) /
          (tf + this.k1 * (1 - this.b + this.b * (this.docLen[docId] / this.avgLen)));
        scores.set(docId, (scores.get(docId) ?? 0) + idf * norm);
      }
    }
    return [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(([id]) => id);
  }

  /**
   * Search. With no dense store this is pure BM25; otherwise the dense and
   * sparse rankings are fused with Reciprocal Rank Fusion (score = Σ 1/(rrfK +
   * rank)), pulling a wider candidate pool from each side than `topK` so a result
   * strong on one side can still surface.
   */
  async search(query: string, topK: number, rrfK = 60): Promise<Document[]> {
    const pool = Math.max(topK * 4, 20);
    if (!this.store) {
      return this.bm25(query, topK).map((id) => this.docs[id]);
    }
    const dense = (await this.store.similaritySearch(query, pool)).map((d) => this.keyOf(d));
    const sparse = this.bm25(query, pool).map((id) => this.keyOf(this.docs[id]));

    const fused = new Map<string, { doc: Document; score: number }>();
    const add = (key: string, rank: number, doc: Document) => {
      const cur = fused.get(key);
      const inc = 1 / (rrfK + rank);
      if (cur) cur.score += inc;
      else fused.set(key, { doc, score: inc });
    };
    dense.forEach((key, i) => add(key, i, this.byKey.get(key)!));
    sparse.forEach((key, i) => add(key, i, this.byKey.get(key)!));

    return [...fused.values()].sort((a, b) => b.score - a.score).slice(0, topK).map((x) => x.doc);
  }

  // Identity for fusion: chunk content is the stable key shared by both sides.
  private byKey = new Map<string, Document>();
  private keyOf(d: Document): string {
    const key = `${d.metadata?.conceptId ?? ""}::${d.pageContent.slice(0, 80)}`;
    if (!this.byKey.has(key)) this.byKey.set(key, d);
    return key;
  }
}
