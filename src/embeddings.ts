import type { Embeddings } from "@langchain/core/embeddings";
import { OllamaEmbeddings } from "@langchain/ollama";
import { LocalEmbeddings } from "./localEmbeddings.js";
import { config } from "./config.js";

/** The active embedding model's human-readable name (for logs / catvecs tag). */
export function embedModelName(): string {
  return config.embedBackend === "ollama" ? config.embedModel : config.localEmbedModel;
}

/**
 * Build the configured embedder. Shared by ingest and every query path so the
 * index is always embedded and searched with the same model. Defaults to the
 * in-process ONNX backend (no ollama required).
 */
export function makeEmbeddings(): Embeddings {
  if (config.embedBackend === "ollama") {
    return new OllamaEmbeddings({ model: config.embedModel, baseUrl: config.ollamaBaseUrl });
  }
  return new LocalEmbeddings();
}
