import * as cheerio from "cheerio";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import { normalizeTitle } from "./okf.js";

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
});
turndown.use(gfm);
// Drop elements that carry no archival value.
turndown.remove(["script", "style"]);

// Preserve <pre> blocks (ASCII maps, room layouts) verbatim as fenced code so
// their spacing survives and the model recognises them as maps.
turndown.addRule("preBlock", {
  filter: "pre",
  replacement: (_content, node: any) => {
    const text = (node.textContent ?? "").replace(/\n+$/, "");
    return `\n\n\`\`\`\n${text}\n\`\`\`\n\n`;
  },
});

// Convert ANY table to a GFM pipe table. The gfm plugin only converts tables
// that already have a heading row and leaves the rest as raw HTML, which is
// common for MediaWiki info-boxes — this rule normalizes all of them.
turndown.addRule("anyTable", {
  filter: "table",
  replacement: (_content, node: any) => {
    const rows = Array.from(node.querySelectorAll("tr")) as any[];
    if (!rows.length) return "";
    const cellText = (cell: any) =>
      turndown
        .turndown(cell.innerHTML ?? "")
        .replace(/\s*\n\s*/g, " ")
        .replace(/\|/g, "\\|")
        .trim();
    const matrix = rows.map((tr) =>
      (Array.from(tr.querySelectorAll("th,td")) as any[]).map(cellText),
    );
    const cols = Math.max(...matrix.map((r) => r.length));
    const pad = (r: string[]) => {
      while (r.length < cols) r.push("");
      return r;
    };
    const line = (r: string[]) => `| ${pad(r).join(" | ")} |`;
    const sep = `| ${Array(cols).fill("---").join(" | ")} |`;
    const [head, ...body] = matrix;
    return `\n\n${[line(head), sep, ...body.map(line)].join("\n")}\n\n`;
  },
});

/** Resolve `/wiki/Foo` style hrefs to a wiki page title, or null if external. */
function hrefToTitle(href: string, articlePath: string): string | null {
  const prefix = articlePath.replace("$1", "");
  if (href.startsWith(prefix)) {
    return normalizeTitle(href.slice(prefix.length).split(/[?#]/)[0]);
  }
  // Some skins emit /index.php?title=Foo for red links.
  const m = /[?&]title=([^&]+)/.exec(href);
  if (m && /action=edit|redlink=1/.test(href)) return normalizeTitle(m[1]);
  return null;
}

export interface ConvertResult {
  markdown: string;
  description: string;
  /** Titles of in-bundle pages this page links to (for graph/index building). */
  linkedTitles: string[];
}

/**
 * Convert rendered MediaWiki HTML into clean OKF markdown:
 * - strips editorial chrome (edit links, ToC, nav/info boxes, categories bar),
 * - rewrites internal links to bundle-relative OKF paths when the target exists,
 * - rewrites internal links to absolute wiki URLs when it does not,
 * - turns red (non-existent) links into plain text.
 *
 * @param resolveConcept maps a normalized wiki title to its OKF concept ID, or
 *   null if that page is not part of the bundle.
 */
export function htmlToOkf(
  html: string,
  opts: {
    articlePath: string;
    absoluteUrlFor: (title: string) => string;
    resolveConcept: (title: string) => string | null;
  },
): ConvertResult {
  const $ = cheerio.load(html);

  // Remove MediaWiki chrome that adds noise to retrieval.
  $(
    ".mw-editsection, #toc, .toc, .navbox, .vertical-navbox, .metadata, .mw-jump-link, .catlinks, .printfooter, .mw-headline-anchor, sup.reference, sup.tipp, .noprint, table.ambox, .mw-empty-elt, span.error, .mw-message-box, .previewnote",
  ).remove();

  const linkedTitles: string[] = [];

  $("a").each((_, el) => {
    const a = $(el);
    const href = a.attr("href") ?? "";
    if (!href || href.startsWith("#")) return;
    const title = hrefToTitle(href, opts.articlePath);
    if (title === null) return; // external / non-wiki link: leave as-is

    const isRed = /action=edit|redlink=1/.test(href) || a.hasClass("new");
    if (isRed) {
      a.replaceWith($("<span>").text(a.text())); // unwrap red link to text
      return;
    }
    const concept = opts.resolveConcept(title);
    if (concept) {
      linkedTitles.push(title);
      a.attr("href", `/${concept}.md`); // bundle-relative OKF link (spec §5.1)
    } else {
      a.attr("href", opts.absoluteUrlFor(title)); // keep usable absolute link
    }
  });

  const content = $("#mw-content-text").length
    ? $("#mw-content-text").html() ?? ""
    : $.root().html() ?? "";

  const markdown = turndown
    .turndown(content)
    .replace(/\\\\/g, "\\") // undo turndown's backslash-escaping (corrupts ASCII maps)
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // Description: first non-empty paragraph anywhere in the fragment.
  const firstPara =
    $("p")
      .filter((_, p) => $(p).text().trim().length > 0)
      .first()
      .text()
      .trim();
  const description = firstPara.replace(/\s+/g, " ").slice(0, 200).trim();

  return { markdown, description, linkedTitles: [...new Set(linkedTitles)] };
}
