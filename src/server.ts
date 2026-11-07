import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { TokenBucketLimiter, rateLimitHeaders } from "./limiter.ts";

const LIMIT = 5;
const WINDOW_MS = 1000;

let cachedPage: string | null = null;

function indexHtml(): string {
  if (cachedPage === null) {
    cachedPage = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  }
  return cachedPage;
}

function send(res: ServerResponse, status: number, body: unknown, type = "application/json; charset=utf-8"): void {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "content-type": type,
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (raw === "") return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("request body must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    throw new Error(err instanceof Error && err.message.startsWith("request body") ? err.message : "request body is not valid JSON");
  }
}

export function createApp(): Server {
  let limiter = new TokenBucketLimiter({ limit: LIMIT, windowMs: WINDOW_MS, burst: LIMIT });

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        return send(res, 200, indexHtml(), "text/html; charset=utf-8");
      }

      if (req.method === "GET" && url.pathname === "/health") {
        return send(res, 200, { status: "ok", limit: LIMIT, windowMs: WINDOW_MS });
      }

      if (req.method === "POST" && url.pathname === "/hit") {
        const body = await readJson(req);
        const key = String(body.key ?? "anonymous");
        const now = Date.now();
        const decision = limiter.check(key, now, 1);
        return send(res, 200, { now, decision, headers: rateLimitHeaders(decision) });
      }

      if (req.method === "POST" && url.pathname === "/reset") {
        limiter = new TokenBucketLimiter({ limit: LIMIT, windowMs: WINDOW_MS, burst: LIMIT });
        return send(res, 204, "");
      }

      return send(res, 404, { error: "not_found", path: url.pathname });
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("request body")) {
        return send(res, 400, { error: "invalid", message: err.message });
      }
      return send(res, 500, { error: "internal", message: "unexpected failure" });
    }
  });
}

// pathToFileURL matters on Windows: argv[1] is a drive path there, which never
// equals the file:/// URL form.
const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  const port = Number(process.env.PORT ?? 4102);
  createApp().listen(port, () => {
    console.log(`cordon listening on http://localhost:${port}`);
  });
}
