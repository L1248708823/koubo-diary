import path from "node:path";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

const captureHost = process.env.CAPTURE_HOST || "127.0.0.1";
const configuredPort = Number(process.env.CAPTURE_PORT || "4173");
const capturePort = Number.isFinite(configuredPort) ? configuredPort : 4173;

export default defineConfig(({ command }) => ({
  root: "capture",
  plugins: [vue()],
  // 本地 dev 才读取生成的 token；生产 build 不把它复制进 dist。
  publicDir: command === "serve" ? "public" : false,
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
