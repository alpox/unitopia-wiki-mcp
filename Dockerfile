# Build + run the Unitopia RAG/MCP server.
FROM node:20-slim

# The optional hnswlib-node addon compiles a native module (used only in the
# EMBED_BACKEND=local/ollama hybrid mode this image runs); needs a toolchain.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy sources before install so the `prepare` script (tsc) can build dist.
COPY package.json package-lock.json .npmrc tsconfig.json ./
COPY src ./src
RUN npm install

ENV NODE_ENV=production \
    EMBED_BACKEND=local \
    INDEX_DIR=/index \
    KB_DIR=/knowledgebase/unitopia \
    PORT=8080

EXPOSE 8080

# Build the index if missing, then start the server.
CMD ["npm", "run", "start:auto"]
