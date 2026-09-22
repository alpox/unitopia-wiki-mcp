import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/** Write JSON atomically (temp file + rename), so two processes starting at once
 *  never read a half-written file. Silent: the stdio MCP's stdout is the protocol. */
export async function saveJson(file: string, data: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(data));
  await rename(tmp, file);
}
