import devServer from "@hono/vite-dev-server"
import path from "path"
import fs from "fs"
const __dirname = import.meta.dirname
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import { inspectAttr } from 'kimi-plugin-inspect-react'

// 关于页展示的版本号：构建时从 package.json 注入
const appVersion = ((): string => {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, "package.json"), "utf8")) as { version?: string };
    return pkg.version ?? "dev";
  } catch {
    return "dev";
  }
})();

// https://vite.dev/config/
export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  plugins: [
    devServer({ entry: "api/boot.ts", exclude: [/^\/(?!api\/).*$/] }),
    inspectAttr(), react()],
  server: {
    port: 3000,
  },
  optimizeDeps: {
    // 防止 @react-three/fiber 被预打包成与 three 不同的实例，
    // 消除 "Multiple instances of Three.js" 警告（配合 resolve.dedupe）。
    exclude: ['@react-three/fiber'],
  },
  resolve: {
    dedupe: ['three'],
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@contracts": path.resolve(__dirname, "./contracts"),
      "@db": path.resolve(__dirname, "./db"),
      "db": path.resolve(__dirname, "./db"),
    },
  },
  envDir: path.resolve(__dirname),
  build: {
    outDir: path.resolve(__dirname, "dist/public"),
    emptyOutDir: true,
  },
});
