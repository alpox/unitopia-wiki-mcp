import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { Document } from "@langchain/core/documents";
import { HNSWLib } from "@langchain/community/vectorstores/hnswlib";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { config } from "./config.js";
import { loadOkfDocuments } from "./loadDocuments.js";
import { makeEmbeddings, embedModelName } from "./embeddings.js";

const embeddings = makeEmbeddings;

/** True if a persisted index already exists on disk. */
export function indexExists(): boolean {
  return existsSync(path.join(config.indexDir, "hnswlib.index"));
}

/** Stable identity of a chunk: its exact text content. */
function chunkHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Load the current OKF bundle and split it into embedding chunks. */
async function loadChunks(): Promise<Document[]> {
  const raw = await loadOkfDocuments();
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: 800,
    chunkOverlap: 120,
  });
  return splitter.splitDocuments(raw);
}

/**
 * Map every chunk in an existing index to its stored vector, keyed by chunk
 * content hash, so unchanged chunks can be reused without re-embedding.
 */
function indexVectorsByHash(prev: HNSWLib): Map<string, Float32Array> {
  const idx = (prev as unknown as { _index: any })._index;
  const docstore = (prev as unknown as { docstore: any }).docstore;
  const count: number = idx.getCurrentCount();
  // Float32Array keeps ~86k×768 vectors near ~265MB instead of ~1GB as number[].
  const byHash = new Map<string, Float32Array>();
  for (let label = 0; label < count; label++) {
    let doc: Document | string;
    try {
      doc = docstore.search(String(label));
    } catch {
      continue;
    }
    if (typeof doc === "string") continue;
    byHash.set(chunkHash(doc.pageContent), Float32Array.from(idx.getPoint(label)));
  }
  return byHash;
}

/**
 * Build the vector index from the OKF bundle, INCREMENTALLY when a previous
 * index exists: reuse stored embeddings for unchanged chunks and only call the
 * embedder for new/changed ones, then rebuild the HNSW graph from the combined
 * vectors (which also drops chunks of deleted/edited pages). Set
 * INGEST_FULL=1 to force a full re-embed.
 */
export async function buildIndex(): Promise<HNSWLib> {
  const docs = await loadChunks();
  const emb = embeddings();
  const batchSize = Number(process.env.EMBED_BATCH_SIZE ?? 256);

  // Reuse cache from the existing index (unless a full rebuild is forced).
  let reuse = new Map<string, Float32Array>();
  if (indexExists() && process.env.INGEST_FULL !== "1") {
    console.log("[ingest] loading existing index for embedding reuse...");
    const prev = await HNSWLib.load(config.indexDir, emb);
    reuse = indexVectorsByHash(prev);
    const currentHashes = new Set(docs.map((d) => chunkHash(d.pageContent)));
    const missing = [...currentHashes].filter((h) => !reuse.has(h)).length;
    const dropped = [...reuse.keys()].some((h) => !currentHashes.has(h));
    if (missing === 0 && !dropped) {
      console.log("[ingest] no content changes — index already up to date.");
      return prev;
    }
    console.log(
      `[ingest] incremental: ${currentHashes.size - missing} chunk-contents reused, ` +
        `${missing} new to embed${dropped ? ", some dropped" : ""}.`,
    );
  } else {
    console.log(`[ingest] full embed of ${docs.length} chunks with ${embedModelName()}.`);
  }

  // Build a fresh index batch-by-batch from reused + freshly embedded vectors.
  const store = new HNSWLib(emb, { space: "cosine" });
  let bufVecs: number[][] = [];
  let bufDocs: Document[] = [];
  let pendDocs: Document[] = [];
  let added = 0;
  let embedded = 0;

  const flush = async () => {
    if (bufDocs.length === 0) return;
    await store.addVectors(bufVecs, bufDocs);
    added += bufDocs.length;
    bufVecs = [];
    bufDocs = [];
    if (added % (batchSize * 10) < batchSize) {
      console.log(`[ingest] indexed ${added}/${docs.length} (embedded ${embedded})`);
      await store.save(config.indexDir); // checkpoint
    }
  };
  const flushPending = async () => {
    if (pendDocs.length === 0) return;
    const vecs = await emb.embedDocuments(pendDocs.map((d) => d.pageContent));
    embedded += pendDocs.length;
    for (let k = 0; k < pendDocs.length; k++) {
      bufVecs.push(vecs[k]);
      bufDocs.push(pendDocs[k]);
    }
    pendDocs = [];
    if (bufDocs.length >= 512) await flush();
  };

  for (const d of docs) {
    const cached = reuse.get(chunkHash(d.pageContent));
    if (cached) {
      bufVecs.push(Array.from(cached));
      bufDocs.push(d);
      if (bufDocs.length >= 512) await flush();
    } else {
      pendDocs.push(d);
      if (pendDocs.length >= batchSize) await flushPending();
    }
  }
  await flushPending();
  await flush();

  await store.save(config.indexDir);
  console.log(
    `[ingest] index saved to ${config.indexDir} (${added} chunks, ${embedded} newly embedded).`,
  );
  return store;
}

/** Load a persisted index, building it first if none exists. */
export async function loadIndex(): Promise<HNSWLib> {
  if (!indexExists()) {
    console.log("[index] no index found, building...");
    return buildIndex();
  }
  return HNSWLib.load(config.indexDir, embeddings());
}
