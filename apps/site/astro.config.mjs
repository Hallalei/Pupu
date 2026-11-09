import { defineConfig } from "astro/config";

// 纯静态输出。申请内测的接口在 worker/ 里，由同一个 Worker 接住 /api/*。
export default defineConfig({
  site: "https://getpupu.com",
  output: "static",
  trailingSlash: "never",
  build: { format: "file" },
  devToolbar: { enabled: false }
});
