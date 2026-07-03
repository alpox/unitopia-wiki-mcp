import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { Document } from "@langchain/core/documents";
import { config } from "./config.js";

/** Reserved OKF filenames that are not concept documents (spec §3.1). */
const RESERVED = new Set(["index.md", "log.md"]);

/** Recursively collect every concept (.md) file path inside the OKF bundle. */
async function collectConceptFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip `_`-prefixed artifact dirs (e.g. `_wikitext`), EXCEPT `_gridmaps`:
      // its `.md` files are real, human-readable overworld-map pages that must be
      // searchable/fetchable (only the sibling `.json` routing artifacts, ignored
      // here since we collect `.md` only, are pure build output).
      if (entry.name.startsWith("_") && entry.name !== config.gridMapsSubdir) continue;
      files.push(...(await collectConceptFiles(full)));
    } else if (entry.name.endsWith(".md") && !RESERVED.has(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

/**
 * Split a markdown body into section blocks on top-level (`#`/`##`) headings so
 * each retrieved chunk stays topically coherent. Falls back to the whole body
 * when there are no headings.
 */
function splitSections(body: string): { heading: string; text: string }[] {
  const lines = body.split("\n");
  const sections: { heading: string; text: string }[] = [];
  let heading = "";
  let buf: string[] = [];
  const flush = () => {
    const text = buf.join("\n").trim();
    if (text) sections.push({ heading, text });
    buf = [];
  };
  for (const line of lines) {
    const m = /^(#{1,2})\s+(.*)$/.exec(line);
    if (m) {
      flush();
      heading = m[2].trim();
    } else {
      buf.push(line);
    }
  }
  flush();
  return sections.length ? sections : [{ heading: "", text: body.trim() }];
}

/**
 * Load the Unitopia OKF bundle into LangChain documents. One document per
 * markdown section, carrying wiki provenance in its metadata so the model can
 * cite the originating page.
 */
export async function loadOkfDocuments(): Promise<Document[]> {
  const root = path.resolve(config.kbDir);
  if (!existsSync(root)) {
    throw new Error(
      `[load] OKF bundle not found at ${root}. Run \`npm run crawl\` first.`,
    );
  }

  const files = await collectConceptFiles(root);
  const docs: Document[] = [];

  for (const file of files) {
    const rawFile = await readFile(file, "utf8");
    const { data: fm, content } = matter(rawFile);
    const title = (fm.title as string) ?? path.basename(file, ".md");
    const url = (fm.resource as string) ?? "";
    const tags = Array.isArray(fm.tags) ? (fm.tags as string[]) : [];
    const conceptId = path
      .relative(root, file)
      .replace(/\.md$/, "")
      .split(path.sep)
      .join("/");

    // Drop the trailing "# Citations" section from retrieval content.
    const body = content.replace(/\n#\s+Citations[\s\S]*$/i, "").trim();

    for (const { heading, text } of splitSections(body)) {
      const headerLine = heading ? `${title} — ${heading}` : title;
      docs.push(
        new Document({
          pageContent: `${headerLine}\n\n${text}`,
          metadata: {
            title,
            url,
            conceptId,
            section: heading,
            tags,
            type: (fm.type as string) ?? "Wiki Article",
            revid: fm.revid ?? null,
            source: "wiki",
          },
        }),
      );
    }
  }

  console.log(`[load] ${docs.length} sections from ${files.length} wiki pages.`);
  return docs;
}
