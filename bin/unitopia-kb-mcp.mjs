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
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const log = (m) => process.stderr.write(`[unitopia-kb] ${m}\n`);

/** Content hash of the shipped archive, so we can tell when a package upgrade
 *  ships a NEW knowledgebase and the persistent extraction has gone stale. */
const archiveStamp = (archive) =>
  crypto.createHash("sha256").update(fs.readFileSync(archive)).digest("hex");

function ensureKb() {
  // Explicit override always wins (docker / monorepo / power users).
  if (process.env.KB_DIR) return;

  // Dev / monorepo checkout: the KB is already sitting next to the package.
  const inRepo = path.join(pkgRoot, "knowledgebase", "unitopia");
  if (fs.existsSync(path.join(inRepo, "index.md"))) {
    process.env.KB_DIR = inRepo;
    return;
  }

  // Installed package: extract the bundled archive into a persistent dir. We
  // re-extract whenever the shipped archive's content hash differs from the one
  // recorded at the last extraction — so upgrading the package (new KB, e.g. the
  // overworld maps) refreshes the data instead of silently reusing a stale tree.
  const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  const dataDir = process.env.UNITOPIA_MCP_DATA || path.join(dataHome, "unitopia-wiki-mcp");
  const kbDir = path.join(dataDir, "unitopia");
  const stampFile = path.join(dataDir, ".kb-archive.sha256");
  const archive = path.join(pkgRoot, "data", "unitopia-kb.tar.gz");
  process.env.KB_DIR = kbDir;

  if (!fs.existsSync(archive)) {
    if (!fs.existsSync(path.join(kbDir, "index.md")))
      log(`WARNING: no KB found and bundled archive missing at ${archive}`);
    return; // nothing to (re)extract — use whatever is already there, if any.
  }

  const want = archiveStamp(archive);
  const have = fs.existsSync(stampFile) ? fs.readFileSync(stampFile, "utf8").trim() : null;
  const extracted = fs.existsSync(path.join(kbDir, "index.md"));
  if (extracted && have === want) return; // up to date

  // Missing or stale → re-extract cleanly so files removed upstream don't linger.
  log(extracted
    ? `knowledgebase archive changed — refreshing ${dataDir} …`
    : `first run — extracting knowledgebase into ${dataDir} …`);
  fs.rmSync(kbDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });
  execFileSync("tar", ["-xzf", archive, "-C", dataDir], { stdio: ["ignore", "ignore", "inherit"] });
  fs.writeFileSync(stampFile, want);
}

ensureKb();
await import("../dist/mcp/stdio.js");
