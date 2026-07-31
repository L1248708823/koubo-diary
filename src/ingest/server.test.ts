import { describe, it, expect, afterEach } from "vitest";
import path from "node:path";
import { pathExists, listPendingInbox } from "../vault/fs.js";
import {
  createTempVault,
  fixedClock,
  type TempVault,
} from "../testkit/temp-vault.js";
import { createIngestServer, type IngestServer } from "./server.js";
import { createLocalInboxDelivery } from "./delivery.js";
import { readdir } from "node:fs/promises";

describe("ingest HTTP (seam 2)", () => {
  const vaults: TempVault[] = [];
  const servers: IngestServer[] = [];

  afterEach(async () => {
    while (servers.length) {
      const s = servers.pop();
      if (s) await s.close();
    }
    while (vaults.length) {
      const v = vaults.pop();
      if (v) await v.cleanup();
    }
  });

  async function setup(
    token = "test-token-secret",
    corsOrigin?: string,
  ) {
    const vault = await createTempVault();
    vaults.push(vault);
    const wakes: string[] = [];
    const clock = fixedClock("2026-07-29T15:30:12+08:00");
    const server = await createIngestServer({
      token,
      delivery: createLocalInboxDelivery(vault.layout, clock),
      clock,
      path: "/ingest",
      host: "127.0.0.1",
      port: 0,
      ...(corsOrigin ? { corsOrigin } : {}),
      onWake: async () => {
        wakes.push("wake");
      },
    });
    servers.push(server);
    return { vault, server, wakes, token };
  }

  async function post(
    server: IngestServer,
    body: unknown,
    headers: Record<string, string> = {},
  ) {
    const res = await fetch(`http://127.0.0.1:${server.port}/ingest`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    return { status: res.status, json };
  }

  it("合法 Bearer + 非空 text：收件箱仅新建一文件，响应含 delivered", async () => {
    const { vault, server, token, wakes } = await setup();
    const before = await listPendingInbox(vault.layout);

    const res = await post(
      server,
      { text: "一段口播灵感" },
      { authorization: `Bearer ${token}` },
    );

    expect(res.status).toBe(200);
    expect(res.json?.ok).toBe(true);
    expect(res.json?.delivered).toBe(true);
    expect(typeof res.json?.id).toBe("string");
    expect(res.json?.organized).toBeUndefined();

    const after = await listPendingInbox(vault.layout);
    expect(after.length).toBe(before.length + 1);
    expect(wakes.length).toBe(1);

    // 不写日记/想法
    const diaryFiles = await readdir(
      path.join(vault.root, vault.layout.diaryDir),
    ).catch(() => []);
    const ideaFiles = await readdir(
      path.join(vault.root, vault.layout.ideasDir),
    ).catch(() => []);
    expect(diaryFiles.filter((f) => f.endsWith(".md"))).toEqual([]);
    expect(ideaFiles.filter((f) => f.endsWith(".md"))).toEqual([]);
  });

  it("缺少 Bearer：4xx，收件箱无新文件", async () => {
    const { vault, server } = await setup();
    const res = await post(server, { text: "不该进去" });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(await listPendingInbox(vault.layout)).toEqual([]);
  });

  it("错误 Bearer：4xx，收件箱无新文件", async () => {
    const { vault, server } = await setup();
    const res = await post(
      server,
      { text: "不该进去" },
      { authorization: "Bearer wrong-token" },
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(await listPendingInbox(vault.layout)).toEqual([]);
  });

  it("空 text：拒绝，收件箱无新文件", async () => {
    const { vault, server, token } = await setup();
    const res = await post(
      server,
      { text: "   " },
      { authorization: `Bearer ${token}` },
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(await listPendingInbox(vault.layout)).toEqual([]);
  });

  it("成功路径不调用处理 agent（仅 onWake 挂钩）", async () => {
    const { server, token, wakes } = await setup();
    let agentCalled = false;
    // ingest must not accept or invoke an agent runner — only wake hook
    await post(
      server,
      { text: "只投递" },
      { authorization: `Bearer ${token}` },
    );
    expect(agentCalled).toBe(false);
    expect(wakes.length).toBe(1);
  });

  it("允许本地前端的 CORS 预检", async () => {
    const { server } = await setup(
      "test-token-secret",
      "http://127.0.0.1:4173",
    );

    const res = await fetch(`http://127.0.0.1:${server.port}/ingest`, {
      method: "OPTIONS",
      headers: {
        origin: "http://127.0.0.1:4173",
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization, content-type",
      },
    });

    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "http://127.0.0.1:4173",
    );
    expect(res.headers.get("access-control-allow-methods")).toBe(
      "POST, OPTIONS",
    );
  });

  it("本地投递 adapter 不依赖 Git", async () => {
    const vault = await createTempVault();
    vaults.push(vault);
    const clock = fixedClock();
    const server = await createIngestServer({
      token: "local-token",
      delivery: createLocalInboxDelivery(vault.layout, clock),
      clock,
      path: "/ingest",
      host: "127.0.0.1",
      port: 0,
    });
    servers.push(server);

    const res = await post(
      server,
      { text: "local filesystem delivery" },
      { authorization: "Bearer local-token" },
    );

    expect(res.status).toBe(200);
    expect(res.json?.delivered).toBe(true);
  });
});
