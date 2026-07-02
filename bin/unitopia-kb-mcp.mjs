#!/usr/bin/env node
// Runnable entry for the Unitopia knowledgebase MCP server (stdio transport).
//
// On first launch it extracts the bundled knowledgebase (data/unitopia-kb.tar.gz,
// shipped in the package) into a persistent data dir — no network, no model, no
// vector index. Subsequent launches reuse it. Then it hands off to the compiled
// stdio server. Registered in package.json `bin`, so it works as:
//   claude mcp add unitopia-kb -- npx -y github:alpox/unitopia-wiki-mcp
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const log = (m) => process.stderr.write(`[unitopia-kb] ${m}\n`);

function ensureKb() {
  // Explicit override always wins (docker / monorepo / power users).
  if (process.env.KB_DIR) return;

  // Dev / monorepo checkout: the KB is already sitting next to the package.
  const inRepo = path.join(pkgRoot, "knowledgebase", "unitopia");
  if (fs.existsSync(path.join(inRepo, "index.md"))) {
    process.env.KB_DIR = inRepo;
    return;
  }

  // Installed package: extract the bundled archive once into a persistent dir.
  const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  const dataDir = process.env.UNITOPIA_MCP_DATA || path.join(dataHome, "unitopia-wiki-mcp");
  const kbDir = path.join(dataDir, "unitopia");
  if (!fs.existsSync(path.join(kbDir, "index.md"))) {
    const archive = path.join(pkgRoot, "data", "unitopia-kb.tar.gz");
    if (!fs.existsSync(archive)) {
      log(`WARNING: no KB found and bundled archive missing at ${archive}`);
      return;
    }
    fs.mkdirSync(dataDir, { recursive: true });
    log(`first run — extracting knowledgebase into ${dataDir} …`);
    execFileSync("tar", ["-xzf", archive, "-C", dataDir], { stdio: ["ignore", "ignore", "inherit"] });
  }
  process.env.KB_DIR = kbDir;
}

ensureKb();
await import("../dist/mcp/stdio.js");
