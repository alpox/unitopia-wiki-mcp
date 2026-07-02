import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

export interface PageState {
  conceptId: string;
  revid: number;
  contenthash: string;
  ns: number;
  title: string;
  description: string;
}

export interface CrawlState {
  lastRun: string | null; // ISO 8601 timestamp of the last successful run
  /** Keyed by normalized wiki title. */
  pages: Record<string, PageState>;
}

const STATE_FILE = ".okf-crawl-state.json";

export function statePath(bundleDir: string): string {
  return path.join(bundleDir, STATE_FILE);
}

export async function loadState(bundleDir: string): Promise<CrawlState> {
  const p = statePath(bundleDir);
  if (!existsSync(p)) return { lastRun: null, pages: {} };
  try {
    return JSON.parse(await readFile(p, "utf8")) as CrawlState;
  } catch {
    return { lastRun: null, pages: {} };
  }
}

export async function saveState(
  bundleDir: string,
  state: CrawlState,
): Promise<void> {
  await mkdir(bundleDir, { recursive: true });
  await writeFile(statePath(bundleDir), JSON.stringify(state, null, 2) + "\n");
}
