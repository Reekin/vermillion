import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const fromHere = (relativePath: string) =>
  fileURLToPath(new URL(relativePath, import.meta.url));

export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@vermillion/shared": fromHere("../../packages/shared/src/index.ts"),
      "@vermillion/core": fromHere("../../packages/core/src/index.ts"),
      "@vermillion/adapters": fromHere("../../packages/adapters/src/index.ts"),
      "@vermillion/workbench": fromHere("../../packages/workbench/src/index.ts")
    }
  },
  build: {
    outDir: "dist-web",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: fromHere("./index.html")
      }
    }
  }
});
