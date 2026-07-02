import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

const USER_AGENT =
  "UnitopiaWikiArchiver/1.0 (OKF knowledgebase crawler; respectful, single-flight)";

export interface HttpResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  finalUrl: string;
}

/**
 * Minimal GET with manual redirect following. Uses the built-in http/https
 * modules so we can disable TLS verification — the Unitopia wiki is HTTP-only
 * and its certificate is expired, so any HTTPS redirect must not be rejected.
 */
export async function httpGet(
  url: string,
  redirectsLeft = 5,
): Promise<HttpResponse> {
  const u = new URL(url);
  const isHttps = u.protocol === "https:";
  const mod = isHttps ? https : http;

  return new Promise<HttpResponse>((resolve, reject) => {
    const req = mod.request(
      u,
      {
        method: "GET",
        headers: { "User-Agent": USER_AGENT, Accept: "*/*" },
        // Expired/invalid cert on the source wiki — accept it deliberately.
        ...(isHttps ? { rejectUnauthorized: false } : {}),
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = res.headers.location;
        if (status >= 300 && status < 400 && location && redirectsLeft > 0) {
          res.resume();
          const next = new URL(location, u).toString();
          resolve(httpGet(next, redirectsLeft - 1));
          return;
        }
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c as Buffer));
        res.on("end", () =>
          resolve({
            status,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
            finalUrl: u.toString(),
          }),
        );
      },
    );
    req.on("error", reject);
    req.setTimeout(30_000, () => req.destroy(new Error(`timeout: ${url}`)));
    req.end();
  });
}

/** GET and parse JSON, throwing on non-2xx or unparseable bodies. */
export async function httpGetJson<T>(url: string): Promise<T> {
  const res = await httpGet(url);
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  try {
    return JSON.parse(res.body) as T;
  } catch {
    throw new Error(`Non-JSON response from ${url}: ${res.body.slice(0, 120)}`);
  }
}

/**
 * POST a urlencoded form body (used for large `action=parse&text=` payloads that
 * exceed practical GET URL limits) and return the parsed JSON.
 */
export async function httpPostFormJson<T>(
  url: string,
  form: URLSearchParams,
): Promise<T> {
  const u = new URL(url);
  const isHttps = u.protocol === "https:";
  const mod = isHttps ? https : http;
  const payload = form.toString();

  const res = await new Promise<HttpResponse>((resolve, reject) => {
    const req = mod.request(
      u,
      {
        method: "POST",
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(payload),
        },
        ...(isHttps ? { rejectUnauthorized: false } : {}),
      },
      (r) => {
        const chunks: Buffer[] = [];
        r.on("data", (c) => chunks.push(c as Buffer));
        r.on("end", () =>
          resolve({
            status: r.statusCode ?? 0,
            headers: r.headers,
            body: Buffer.concat(chunks).toString("utf8"),
            finalUrl: u.toString(),
          }),
        );
      },
    );
    req.on("error", reject);
    req.setTimeout(120_000, () => req.destroy(new Error(`timeout: ${url}`)));
    req.end(payload);
  });

  if (res.status < 200 || res.status >= 300) {
    throw new Error(`HTTP ${res.status} for POST ${url}`);
  }
  try {
    return JSON.parse(res.body) as T;
  } catch {
    throw new Error(`Non-JSON POST response from ${url}: ${res.body.slice(0, 120)}`);
  }
}

/** Cooperative delay between requests to stay polite to an aging server. */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
