import express, { type Request, type Response } from "express";
import { z } from "zod";
import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import { config } from "./config.js";
import { buildGraph } from "./graph.js";
import { initBackends } from "./backends.js";

const ChatMessage = z.object({
  role: z.enum(["system", "user", "assistant", "tool", "function"]),
  content: z.union([z.string(), z.array(z.any()), z.null()]).optional(),
});

const ChatRequest = z.object({
  model: z.string().optional(),
  messages: z.array(ChatMessage).min(1),
  stream: z.boolean().optional(),
});

/** Flatten OpenAI content (string or content-parts array) into plain text. */
function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === "string" ? part : typeof part?.text === "string" ? part.text : "",
      )
      .join("");
  }
  return "";
}

/** Map OpenAI messages to LangChain messages. */
function toLangChainMessages(
  msgs: z.infer<typeof ChatRequest>["messages"],
): BaseMessage[] {
  return msgs.map((m) => {
    const text = contentToText(m.content);
    switch (m.role) {
      case "system":
        return new SystemMessage(text);
      case "assistant":
        return new AIMessage(text);
      default:
        return new HumanMessage(text);
    }
  });
}

const openAiId = () => `chatcmpl-${Math.random().toString(36).slice(2)}`;

async function main() {
  const { store, catalog, nav, hybrid } = await initBackends();
  const graph = buildGraph(store, catalog, nav, hybrid);
  console.log("[server] graph ready");

  const app = express();
  app.use(express.json({ limit: "10mb" }));

  app.get("/health", (_req, res) => res.json({ status: "ok" }));

  app.get("/v1/models", (_req, res) => {
    res.json({
      object: "list",
      data: [
        {
          id: config.servedModelId,
          object: "model",
          created: Math.floor(Date.now() / 1000),
          owned_by: "unitopia-rag",
        },
      ],
    });
  });

  app.post("/v1/chat/completions", async (req: Request, res: Response) => {
    const parsed = ChatRequest.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: { message: parsed.error.message, type: "invalid_request_error" },
      });
    }
    const { messages, stream } = parsed.data;
    const lcMessages = toLangChainMessages(messages);
    const created = Math.floor(Date.now() / 1000);
    const id = openAiId();

    try {
      if (stream) {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.flushHeaders?.();

        const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

        // role delta first
        send({
          id,
          object: "chat.completion.chunk",
          created,
          model: config.servedModelId,
          choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
        });

        // Stream tokens from the generate node only.
        const eventStream = await graph.stream(
          { messages: lcMessages },
          { streamMode: "messages" },
        );
        // qwen3 streams its reasoning first, then a literal </think>, then the
        // answer. Suppress everything up to and including the first </think> so
        // only the real answer is streamed. (If a reply has no </think>, it had
        // no reasoning — the buffer is flushed unchanged at the end.)
        let thinkDone = false;
        let buf = "";
        for await (const [chunk, meta] of eventStream as AsyncIterable<
          [BaseMessage, { langgraph_node?: string }]
        >) {
          if (meta?.langgraph_node !== "generate") continue;
          const text = contentToText(chunk.content);
          if (!text) continue;
          let emit = "";
          if (thinkDone) {
            emit = text;
          } else {
            buf += text;
            const i = buf.indexOf("</think>");
            if (i !== -1) { emit = buf.slice(i + "</think>".length).replace(/^\s+/, ""); thinkDone = true; buf = ""; }
          }
          if (!emit) continue;
          send({
            id,
            object: "chat.completion.chunk",
            created,
            model: config.servedModelId,
            choices: [{ index: 0, delta: { content: emit }, finish_reason: null }],
          });
        }
        // No </think> ever appeared → the whole reply was the answer (no thinking).
        if (!thinkDone && buf.trim()) {
          send({
            id,
            object: "chat.completion.chunk",
            created,
            model: config.servedModelId,
            choices: [{ index: 0, delta: { content: buf }, finish_reason: null }],
          });
        }

        send({
          id,
          object: "chat.completion.chunk",
          created,
          model: config.servedModelId,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        });
        res.write("data: [DONE]\n\n");
        return res.end();
      }

      // Non-streaming
      const result = await graph.invoke({ messages: lcMessages });
      const final = result.messages[result.messages.length - 1];
      const answer = contentToText(final?.content);

      return res.json({
        id,
        object: "chat.completion",
        created,
        model: config.servedModelId,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: answer },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
    } catch (err) {
      console.error("[server] completion error:", err);
      if (!res.headersSent) {
        res
          .status(500)
          .json({ error: { message: String(err), type: "internal_error" } });
      } else {
        res.end();
      }
    }
  });

  app.listen(config.port, "0.0.0.0", () => {
    console.log(
      `[server] OpenAI-compatible RAG API on http://0.0.0.0:${config.port}/v1 (model: ${config.servedModelId})`,
    );
  });
}

main().catch((err) => {
  console.error("[server] fatal:", err);
  process.exit(1);
});
