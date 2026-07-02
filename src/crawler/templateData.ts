/**
 * Extract scalar key/value parameters from a page's MediaWiki templates
 * (e.g. {{Rätsel|Typ=Pflicht|Erfahrung=3000}} or {{Info|Gewicht=1|...}}) and
 * render them as a "## Kenndaten" markdown block.
 *
 * These values (experience, type, area, item stats, …) are otherwise lost: the
 * templates render them into styled boxes/category links, not body text, so the
 * model never sees the actual numbers. We recover them from the raw wikitext.
 */

/** Long/free-text params that don't belong in a compact key/value block. */
const SKIP = new Set(
  [
    "Aussehen",
    "PreAussehen",
    "Beschreibung",
    "Bild",
    "Image",
    "Text",
    "Funktion",
    "Meldung",
    "Langbeschreibung",
    "Kurzbeschreibung",
    "Titel",
  ].map((s) => s.toLowerCase()),
);

/** Collect the inner text of every top-level {{…}} template in `wt`. */
function topLevelTemplates(wt: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < wt.length; i++) {
    if (wt[i] === "{" && wt[i + 1] === "{") {
      let depth = 0;
      let j = i;
      for (; j < wt.length; j++) {
        if (wt[j] === "{" && wt[j + 1] === "{") {
          depth++;
          j++;
        } else if (wt[j] === "}" && wt[j + 1] === "}") {
          depth--;
          j++;
          if (depth === 0) break;
        }
      }
      out.push(wt.slice(i + 2, j - 1));
      i = j;
    }
  }
  return out;
}

/** Split a template body on top-level `|`, respecting nested {{}} and [[]]. */
function splitTopLevel(inner: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let buf = "";
  for (let i = 0; i < inner.length; i++) {
    const two = inner.substr(i, 2);
    if (two === "{{" || two === "[[") {
      depth++;
      buf += two;
      i++;
    } else if (two === "}}" || two === "]]") {
      depth = Math.max(0, depth - 1);
      buf += two;
      i++;
    } else if (inner[i] === "|" && depth === 0) {
      parts.push(buf);
      buf = "";
    } else {
      buf += inner[i];
    }
  }
  parts.push(buf);
  return parts;
}

/** Split "Key=Value" at the first top-level `=`, else return null (positional). */
function splitKeyValue(part: string): [string, string] | null {
  let depth = 0;
  for (let i = 0; i < part.length; i++) {
    const two = part.substr(i, 2);
    if (two === "{{" || two === "[[") {
      depth++;
      i++;
    } else if (two === "}}" || two === "]]") {
      depth = Math.max(0, depth - 1);
      i++;
    } else if (part[i] === "=" && depth === 0) {
      return [part.slice(0, i).trim(), part.slice(i + 1).trim()];
    }
  }
  return null;
}

/** Reduce wiki markup in a short value to readable plain text. */
function cleanValue(v: string): string {
  return v
    .replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, "$1") // [[a|b]] → b
    .replace(/\{\{[^{}]*\}\}/g, "") // drop nested templates
    .replace(/'''?/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Build a "## Kenndaten" block from a page's wikitext, or "" if none apply. */
export function extractKenndaten(wikitext: string): string {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const inner of topLevelTemplates(wikitext)) {
    const parts = splitTopLevel(inner);
    for (let k = 1; k < parts.length; k++) {
      const kv = splitKeyValue(parts[k]);
      if (!kv) continue;
      const key = kv[0];
      const val = cleanValue(kv[1]);
      const lk = key.toLowerCase();
      if (!key || key.length > 30 || SKIP.has(lk) || seen.has(lk)) continue;
      if (!val || val.length > 80 || /\n/.test(val)) continue;
      seen.add(lk);
      lines.push(`- ${key}: ${val}`);
      if (lines.length >= 15) break;
    }
    if (lines.length >= 15) break;
  }
  return lines.length ? `## Kenndaten\n\n${lines.join("\n")}` : "";
}
