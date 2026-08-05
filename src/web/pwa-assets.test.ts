import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const pwaRoot = path.join(repositoryRoot, "capture", "pwa-public");

describe("capture PWA assets", () => {
  it("声明独立窗口、品牌图标和离线壳", async () => {
    const manifest = JSON.parse(
      await readFile(path.join(pwaRoot, "manifest.webmanifest"), "utf8"),
    ) as {
      name: string;
      short_name: string;
      display: string;
      start_url: string;
      scope: string;
      icons: { src: string; type: string; sizes: string }[];
    };
    const index = await readFile(
      path.join(repositoryRoot, "capture", "index.html"),
      "utf8",
    );
    const serviceWorker = await readFile(path.join(pwaRoot, "sw.js"), "utf8");

    expect(manifest).toMatchObject({
      name: "Yan帳",
      short_name: "Yan帳",
      display: "standalone",
      start_url: "/",
      scope: "/",
    });
    expect(manifest.icons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          src: "/icons/icon.svg",
          sizes: "any",
          type: "image/svg+xml",
        }),
      ]),
    );
    expect(index).toContain('rel="manifest" href="/manifest.webmanifest"');
    expect(index).toContain('rel="apple-touch-icon" href="/icons/icon.svg"');
    expect(serviceWorker).toContain('request.method !== "GET"');
    expect(serviceWorker).toContain('url.pathname.endsWith("/ingest")');
  });
});
