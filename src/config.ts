import "dotenv/config";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * Package root, resolved relative to this module rather than the process cwd.
 * At run time this file is `dist/config.js`, so the package root is one level up
 * from `dist/`. This lets the server (and the MCP entry) launch from *any*
 * working directory and still find the bundled index, KB and ONNX model — which
 * is what makes the git/one-command install work regardless of where Claude Code
 * spawns the process from. The `INDEX_DIR`/`KB_DIR` env vars still override these
 * (used by the docker/monorepo setup).
 */
export const pkgRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/** Central runtime configuration, all overridable via environment variables. */
export const config = {
  /** Base URL of the ollama server. Inside compose this is the service name. */
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434",

  /** Generation model (already installed in your ollama container). */
  chatModel: process.env.CHAT_MODEL ?? "qwen3:latest",

  /**
   * Retrieval/embedding backend:
   * - "none" (default): BM25-only, pure-JS, fully offline — no vector index, no
   *   embedding model, no native `hnswlib-node`. What the git/npx install uses.
   * - "local": runs an ONNX model in-process (transformers.js) and fuses dense
   *   vectors with BM25 (hybrid). Needs a prebuilt index.
   * - "ollama": same, but embeds via the ollama-hosted model.
   * For "local"/"ollama" the prebuilt index MUST be built with the same
   * backend/model that queries it, or vectors won't match.
   */
  embedBackend: (process.env.EMBED_BACKEND ?? "none") as "none" | "local" | "ollama",

  /** ONNX embedding model (transformers.js) used when embedBackend === "local". */
  localEmbedModel: process.env.LOCAL_EMBED_MODEL ?? "Xenova/multilingual-e5-base",

  /** Embedding model used to build/query the vector index (ollama backend). */
  embedModel: process.env.EMBED_MODEL ?? "nomic-embed-text",

  /** HTTP port the OpenAI-compatible server listens on. */
  port: Number(process.env.PORT ?? 8080),

  /** HTTP port the streamable-HTTP MCP server listens on. */
  mcpPort: Number(process.env.MCP_PORT ?? 8090),

  /** Number of documents retrieved per query. */
  topK: Number(process.env.TOP_K ?? 6),

  /** Where the persisted HNSWLib index lives (mounted volume in docker). */
  indexDir: process.env.INDEX_DIR ?? path.join(pkgRoot, "index"),

  /** Root of the OKF knowledge bundle crawled from the Unitopia wiki. */
  kbDir: process.env.KB_DIR ?? path.join(pkgRoot, "knowledgebase/unitopia"),

  /** Base URL of the Unitopia MediaWiki (HTTP-only, expired TLS cert). */
  wikiBaseUrl: process.env.WIKI_BASE_URL ?? "http://unitopia.intelligense.de",

  /** Subdir (under kbDir) holding parsed overworld grid-map artifacts. Ships in
   *  the KB tarball (build:data excludes only `_wikitext`). */
  gridMapsSubdir: "_gridmaps",

  /** Overworld regions (as keyed in Vorlage:Kachelkarte) to parse from gifs into
   *  routable grid maps: the 17 tile-overworlds + the 10 "Verfluchter Wald"
   *  segments. Override via GRID_MAP_REGIONS (comma-separated) for a subset. */
  gridMapRegions: (process.env.GRID_MAP_REGIONS ?? [
    "Asia", "Drachenland", "Amerindia", "Nankea", "Wurzelwald", "Vaniorh",
    "Midgard2012", "Gallien2012", "Dörrland2012", "Kreta", "Phrygia", "Stratos",
    "Veldergautland", "Märchenland", "Okeanos", "Kokosinseln", "Inseln2012",
    "Verfluchter Wald", "Verfluchter Wald Welle", "Verfluchter Wald Kreis",
    "Verfluchter Wald Stern", "Verfluchter Wald U", "Verfluchter Wald Baum",
    "Verfluchter Wald Doppelkreis", "Verfluchter Wald Ring",
    "Verfluchter Wald Fünfeck", "Verfluchter Wald Mond",
  ].join(",")).split(",").map((s) => s.trim()).filter(Boolean),

  /** Model id advertised over the OpenAI API (what Qwen Code targets). */
  servedModelId: process.env.SERVED_MODEL_ID ?? "qwen3-unitopia-rag",

  /**
   * qwen3 is a "thinking" model. For a coding assistant we disable the
   * <think> stream so Qwen Code gets clean answers. Set THINK=true to re-enable.
   */
  think: process.env.THINK === "true",

  /** Max number of prior turns (user+assistant messages) kept for context. */
  maxHistoryMessages: Number(process.env.MAX_HISTORY_MESSAGES ?? 10),

  /**
   * Max characters of the latest user message used as the retrieval query.
   * Keeps the embedding request under nomic-embed-text's context window when
   * clients (e.g. Qwen Code) send very large prompts.
   */
  maxQueryChars: Number(process.env.MAX_QUERY_CHARS ?? 1200),
} as const;
