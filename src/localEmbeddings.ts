import { Embeddings, type EmbeddingsParams } from "@langchain/core/embeddings";
import { pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";
import { config } from "./config.js";

/**
 * In-process embeddings via ONNX Runtime (transformers.js) — no ollama, no
 * external service. The model runs inside the MCP/RAG process, so semantic
 * search works fully offline (the ONNX weights are fetched once from the
 * HuggingFace hub and then cached under ~/.cache/huggingface).
 *
 * Default model is the multilingual E5 base (768-dim, same shape as the former
 * nomic-embed-text index). E5 models are trained with instruction prefixes:
 * "query: " for search queries and "passage: " for indexed documents — omitting
 * them measurably degrades retrieval, so we add them here.
 */
export class LocalEmbeddings extends Embeddings {
  private readonly model: string;
  private extractor: Promise<FeatureExtractionPipeline> | null = null;

  constructor(params: EmbeddingsParams = {}) {
    super(params);
    this.model = config.localEmbedModel;
  }

  private pipe(): Promise<FeatureExtractionPipeline> {
    if (!this.extractor) {
      // `dtype: "q8"` uses the quantised ONNX weights: ~4× smaller download and
      // faster CPU inference, with negligible retrieval-quality loss.
      this.extractor = pipeline("feature-extraction", this.model, { dtype: "q8" });
    }
    return this.extractor;
  }

  private async embed(texts: string[]): Promise<number[][]> {
    const extractor = await this.pipe();
    const out = await extractor(texts, { pooling: "mean", normalize: true });
    return out.tolist() as number[][];
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    return this.embed(texts.map((t) => `passage: ${t}`));
  }

  async embedQuery(text: string): Promise<number[]> {
    const [vec] = await this.embed([`query: ${text}`]);
    return vec;
  }
}
