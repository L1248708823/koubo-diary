import http from "node:http";
import type { Clock } from "../types.js";
import type { InboxDelivery } from "./delivery.js";
import { logError, logInfo } from "../runtime/log.js";

export type IngestServerOptions = {
  token: string;
  delivery: InboxDelivery;
  clock: Clock;
  host?: string;
  port?: number;
  path?: string;
  corsOrigin?: string;
  maxTextLength?: number;
  /** 投递成功后的唤醒挂钩（写 flag / 调编排 / systemctl…） */
  onWake?: () => Promise<void> | void;
};

export type IngestServer = {
  port: number;
  host: string;
  close(): Promise<void>;
};

type JsonBody = {
  text?: unknown;
  captured_at?: unknown;
};

export async function createIngestServer(
  opts: IngestServerOptions,
): Promise<IngestServer> {
  const route = opts.path ?? "/ingest";
  const maxLen = opts.maxTextLength ?? 20_000;

  const server = http.createServer((req, res) => {
    void handle(req, res);
  });

  async function handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    try {
      if (req.method === "GET" && req.url === "/health") {
        sendJson(res, 200, { ok: true });
        return;
      }

      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const corsAllowed = applyCorsHeaders(req, res, opts.corsOrigin);
      if (req.method === "OPTIONS" && url.pathname === route) {
        if (!corsAllowed) {
          sendJson(res, 403, { ok: false, error: "cors origin denied" });
          return;
        }
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.method !== "POST" || url.pathname !== route) {
        sendJson(res, 404, { ok: false, error: "not found" });
        return;
      }

      const auth = req.headers.authorization ?? "";
      const expected = `Bearer ${opts.token}`;
      if (!opts.token || auth !== expected) {
        sendJson(res, 401, { ok: false, error: "unauthorized" });
        return;
      }

      const raw = await readBody(req, maxLen + 1024);
      let body: JsonBody;
      try {
        body = JSON.parse(raw) as JsonBody;
      } catch {
        sendJson(res, 400, { ok: false, error: "invalid json" });
        return;
      }

      if (typeof body.text !== "string") {
        sendJson(res, 400, { ok: false, error: "text required" });
        return;
      }
      const text = body.text.trim();
      if (!text) {
        sendJson(res, 400, { ok: false, error: "text empty" });
        return;
      }
      if (text.length > maxLen) {
        sendJson(res, 400, { ok: false, error: "text too long" });
        return;
      }

      let capturedAt: string;
      if (body.captured_at === undefined || body.captured_at === null) {
        capturedAt = opts.clock.now().toISOString();
      } else if (typeof body.captured_at === "string" && body.captured_at.trim()) {
        const d = new Date(body.captured_at);
        if (Number.isNaN(d.getTime())) {
          sendJson(res, 400, { ok: false, error: "captured_at invalid" });
          return;
        }
        capturedAt = body.captured_at;
      } else {
        sendJson(res, 400, { ok: false, error: "captured_at invalid" });
        return;
      }

      const delivered = await opts.delivery.deliver({ text, capturedAt });
      if (!delivered.ok) {
        logError("ingest.delivery_failed", {
          reason: delivered.reason,
          conflict: delivered.conflict ?? false,
        });
        sendJson(res, 503, {
          ok: false,
          error: delivered.reason,
          delivered: false,
          ...(delivered.conflict ? { conflict: true } : {}),
        });
        return;
      }

      logInfo("ingest.delivered", {
        id: delivered.id,
        textLength: text.length,
      });

      try {
        await opts.onWake?.();
      } catch {
        logError("ingest.wake_failed");
        // 唤醒失败不否定已投递；托底 cron 仍会消化
      }

      sendJson(res, 200, { ok: true, id: delivered.id, delivered: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : "internal error";
      sendJson(res, 500, { ok: false, error: message });
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", () => resolve());
  });

  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("failed to bind ingest server");
  }

  return {
    port: addr.port,
    host: addr.address,
    close() {
      return new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

function applyCorsHeaders(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  allowedOrigin: string | undefined,
): boolean {
  const origin = req.headers.origin;
  if (!allowedOrigin || origin !== allowedOrigin) return false;
  res.setHeader("access-control-allow-origin", allowedOrigin);
  res.setHeader("access-control-allow-methods", "POST, OPTIONS");
  res.setHeader("access-control-allow-headers", "Authorization, Content-Type");
  res.setHeader("vary", "Origin");
  return true;
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(
  req: http.IncomingMessage,
  limit: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
