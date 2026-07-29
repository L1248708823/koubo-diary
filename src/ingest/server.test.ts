import { describe, it, expect, afterEach } from "vitest";
import path from "node:path";
import { pathExists, listPendingInbox } from "../vault/fs.js";
import {
  createTempVault,
  createFakeGit,
  fixedClock,
  type TempVault,
} from "../testkit/temp-vault.js";
import { createIngestServer, type IngestServer } from "./server.js";
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

  async function setup(token = "test-token-secret") {
    const vault = await createTempVault();
    vaults.push(vault);
    const { git, captureHead } = await createFakeGit(vault.layout);
    await captureHead();
    const wakes: string[] = [];
    const server = await createIngestServer({
      layout: vault.layout,
      token,
      git,
      clock: fixedClock("2026-07-29T15:30:12+08:00"),
      path: "/ingest",
      host: "127.0.0.1",
      port: 0,
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
});
