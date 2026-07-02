# Qwen Code CLI, pre-configured to use the local Unitopia RAG server as its model backend.
FROM node:20-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g @qwen-code/qwen-code@latest

# Pre-select the OpenAI-compatible provider so `qwen` starts without the
# interactive auth-method picker. Model/baseUrl/apiKey come from OPENAI_* env.
COPY settings.json /root/.qwen/settings.json

# Self-contained defaults pointing at the Unitopia RAG server (compose overrides
# these for the in-network service name). Any non-empty API key works locally.
ENV OPENAI_BASE_URL=http://localhost:8080/v1 \
    OPENAI_API_KEY=local-no-key-needed \
    OPENAI_MODEL=qwen3-unitopia-rag

# Work on the mounted project by default.
WORKDIR /workspace

# Keep the container alive so you can `docker compose exec qwen-code qwen`.
CMD ["sleep", "infinity"]
