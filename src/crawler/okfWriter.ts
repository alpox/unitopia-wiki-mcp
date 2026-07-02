import { writeFile, mkdir, readFile, rm, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

export interface ConceptDoc {
  conceptId: string;
  type: string;
  title: string;
  description: string;
  resource: string;
  tags: string[];
  timestamp: string;
  revid: number;
  namespace: number;
  contenthash: string;
  body: string; // markdown body (without frontmatter / citations)
}

/** Serialize a YAML scalar safely (quote when it could be misparsed). */
function yamlStr(s: string): string {
  if (s === "") return '""';
  // Quote values that YAML would otherwise coerce to a number/bool/null.
  if (/^[\d.+-]+$/.test(s) || /^(true|false|null|yes|no|on|off)$/i.test(s)) {
    return `"${s.replace(/"/g, '\\"')}"`;
  }
  if (/[:#\-?{}\[\],&*!|>'"%@`]|^\s|\s$/.test(s)) {
    return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return s;
}

/** Render one OKF concept document (frontmatter + body + citation). */
function renderConcept(doc: ConceptDoc): string {
  const fm = [
    "---",
    `type: ${yamlStr(doc.type)}`,
    `title: ${yamlStr(doc.title)}`,
    `description: ${yamlStr(doc.description)}`,
    `resource: ${yamlStr(doc.resource)}`,
    `tags: [${doc.tags.map((t) => yamlStr(t)).join(", ")}]`,
    `timestamp: ${doc.timestamp}`,
    `revid: ${doc.revid}`,
    `namespace: ${doc.namespace}`,
    `contenthash: ${doc.contenthash}`,
    "---",
  ].join("\n");

  const citation = `# Citations\n\n[1] [Originalseite im Unitopia-Wiki](${doc.resource})\n`;
  return `${fm}\n\n${doc.body}\n\n${citation}`;
}

/** Write a concept document to its path within the bundle. */
export async function writeConcept(
  bundleDir: string,
  doc: ConceptDoc,
): Promise<void> {
  const file = path.join(bundleDir, `${doc.conceptId}.md`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, renderConcept(doc));
}

/** Remove a concept file (used when a page is deleted upstream). */
export async function removeConcept(
  bundleDir: string,
  conceptId: string,
): Promise<void> {
  const file = path.join(bundleDir, `${conceptId}.md`);
  if (existsSync(file)) await rm(file);
  const wiki = path.join(bundleDir, "_wikitext", `${conceptId}.wiki`);
  if (existsSync(wiki)) await rm(wiki);
}

/**
 * Persist a page's raw wikitext under `_wikitext/` as a durable, re-importable
 * backup, independent of how the OKF markdown body was rendered. The leading
 * underscore keeps this directory out of OKF concept traversal and indexes.
 */
export async function writeWikitext(
  bundleDir: string,
  conceptId: string,
  wikitext: string,
): Promise<void> {
  const file = path.join(bundleDir, "_wikitext", `${conceptId}.wiki`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, wikitext);
}

/**
 * Regenerate `index.md` files for the bundle root and every subdirectory
 * (OKF §6, progressive disclosure). Lists concepts with their descriptions and
 * links to nested subdirectories. The root index also declares okf_version.
 */
export async function writeIndexes(
  bundleDir: string,
  descriptions: Map<string, string>, // conceptId -> description
  titles: Map<string, string>, // conceptId -> title
): Promise<void> {
  async function walk(dir: string): Promise<void> {
    const rel = path.relative(bundleDir, dir);
    const entries = await readdir(dir, { withFileTypes: true });
    const concepts: string[] = [];
    const subdirs: string[] = [];
    for (const e of entries) {
      if (e.isDirectory()) {
        if (e.name.startsWith("_")) continue; // skip _wikitext archive etc.
        subdirs.push(e.name);
        await walk(path.join(dir, e.name));
      } else if (
        e.name.endsWith(".md") &&
        e.name !== "index.md" &&
        e.name !== "log.md"
      ) {
        concepts.push(e.name);
      }
    }

    const isRoot = rel === "";
    const lines: string[] = [];
    if (isRoot) {
      lines.push("---", 'okf_version: "0.1"', "---", "");
      lines.push("# Unitopia-Wiki — Wissensbündel (OKF)", "");
      lines.push(
        "Archiv des Unitopia-MUD-Wikis im Open Knowledge Format. Jede Seite ist ein Konzeptdokument.",
        "",
      );
    } else {
      lines.push(`# ${rel}`, "");
    }

    if (concepts.length) {
      lines.push("# Seiten", "");
      for (const c of concepts.sort()) {
        const conceptId = path
          .join(rel, c.replace(/\.md$/, ""))
          .split(path.sep)
          .join("/");
        const title = titles.get(conceptId) ?? c.replace(/\.md$/, "");
        const desc = descriptions.get(conceptId) ?? "";
        lines.push(`* [${title}](${c})${desc ? ` - ${desc}` : ""}`);
      }
      lines.push("");
    }
    if (subdirs.length) {
      lines.push("# Bereiche", "");
      for (const d of subdirs.sort()) lines.push(`* [${d}](${d}/)`);
      lines.push("");
    }

    await writeFile(path.join(dir, "index.md"), lines.join("\n"));
  }

  await walk(bundleDir);
}

/** Prepend a dated section to the bundle's log.md (OKF §7, newest first). */
export async function appendLog(
  bundleDir: string,
  entries: { kind: "Creation" | "Update" | "Deprecation"; line: string }[],
): Promise<void> {
  if (entries.length === 0) return;
  const file = path.join(bundleDir, "log.md");
  const today = new Date().toISOString().slice(0, 10);
  const section = [
    `## ${today}`,
    ...entries.map((e) => `* **${e.kind}**: ${e.line}`),
    "",
  ].join("\n");

  let existing = "";
  if (existsSync(file)) existing = await readFile(file, "utf8");
  if (!existing) existing = "# Änderungsprotokoll\n\n";

  // Insert the new section right after the H1 header.
  const headerEnd = existing.indexOf("\n\n");
  const head = existing.slice(0, headerEnd + 2);
  const rest = existing.slice(headerEnd + 2);
  await writeFile(file, `${head}${section}\n${rest}`);
}
