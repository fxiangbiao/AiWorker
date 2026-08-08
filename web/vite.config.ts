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
      "/api": "http://localhost:3000",
    },
  },
});
