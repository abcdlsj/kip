import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

/**
 * Plugin pages are their own windows, so they build separately from the main
 * view. They load at `views://plugins/<id>/index.html`, where `plugins` is the
 * URL authority, so `base: "/"` resolves `/assets/...` to `views/plugins/assets/`.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: "src/webview",
  base: "/",
  build: {
    outDir: "../../dist-plugins",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        gemini2api: fileURLToPath(
          new URL("./src/webview/plugins/gemini2api/index.html", import.meta.url),
        ),
      },
    },
  },
});
