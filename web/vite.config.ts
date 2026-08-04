import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  plugins: [svelte()],
  base: "./",
  resolve: {
    alias: {
      "$lib": resolve(__dirname, "src/lib"),
    },
  },
  build: { outDir: "dist" },
  server: {
    proxy: {
      "/chat": "http://localhost:3000",
      "/agents": "http://localhost:3000",
      "/status": "http://localhost:3000",
      "/sessions": "http://localhost:3000",
      "/tools": "http://localhost:3000",
    },
  },
});
