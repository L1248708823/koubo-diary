import path from "node:path";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

const captureHost = process.env.CAPTURE_HOST || "127.0.0.1";
const configuredPort = Number(process.env.CAPTURE_PORT || "4173");
const capturePort = Number.isFinite(configuredPort) ? configuredPort : 4173;

export default defineConfig(({ command }) => ({
  root: "capture",
  plugins: [vue()],
  // 开发环境读取本机 token；生产构建只复制不含密钥的 PWA 静态资源。
  publicDir: command === "serve" ? "public" : "pwa-public",
  server: {
    host: captureHost,
    port: capturePort,
    strictPort: true,
  },
  preview: {
    host: captureHost,
    port: capturePort,
    strictPort: true,
  },
  build: {
    outDir: "../dist/capture",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        capture: path.resolve(process.cwd(), "capture/index.html"),
      },
    },
  },
}));
