import type { SiteInfo } from "./mediaWikiClient.js";

/** Normalize a wiki title for use as a lookup key (underscores == spaces). */
export function normalizeTitle(title: string): string {
  return decodeURIComponent(title).replace(/_/g, " ").trim();
}

/** URL/filesystem-safe slug that still preserves German umlauts. */
function slug(s: string): string {
  return s
    .normalize("NFC")
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[\\/:*?"<>|#]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Map a wiki title to its OKF concept ID (path within the bundle, no `.md`).
 * Main namespace lives at the bundle root; other namespaces become a
 * subdirectory named after the (slugged) namespace, e.g. `kategorie/foo`.
 */
export function conceptIdFor(site: SiteInfo, ns: number, title: string): string {
  const plain = normalizeTitle(title);
  const nsInfo = site.namespaces.get(ns);
  const nsName = nsInfo?.name ?? "";
  let local = plain;
  if (nsName && plain.startsWith(`${nsName}:`)) {
    local = plain.slice(nsName.length + 1);
  }
  const file = slug(local) || "index-page";
  if (ns === 0 || !nsName) return file;
  return `${slug(nsName)}/${file}`;
}

/** OKF `type` value for a namespace. */
export function typeFor(site: SiteInfo, ns: number): string {
  if (ns === 14) return "Wiki Category";
  if (ns === 12) return "Wiki Help";
  const nsInfo = site.namespaces.get(ns);
  return nsInfo?.name ? `Wiki ${nsInfo.name}` : "Wiki Article";
}
