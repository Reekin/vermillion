import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const fromHere = (relativePath: string) =>
  fileURLToPath(new URL(relativePath, import.meta.url));

// The phone page is built as its own graph so it never loads the desktop shell's shared chunk.
export default defineConfig(({ mode }) => ({
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@vermillion/shared/tool-actions": fromHere("../../packages/shared/src/tool-actions.ts"),
      "@vermillion/shared": fromHere("../../packages/shared/src/index.ts"),
      "@vermillion/core": fromHere("../../packages/core/src/index.ts"),
      "@vermillion/adapters": fromHere("../../packages/adapters/src/index.ts"),
      "@vermillion/workbench/client": fromHere("../../packages/workbench/src/client.ts"),
      "@vermillion/workbench": fromHere("../../packages/workbench/src/index.ts")
    }
  },
  build: {
    outDir: "dist-web",
    emptyOutDir: mode !== "mobile",
    rollupOptions: {
      input: mode === "mobile" ? { mobile: fromHere("./mobile.html") } : { main: fromHere("./index.html") },
      // The phone page never edits source; let the shared UI barrel's code editor drop out of its graph.
      ...(mode === "mobile" ? {
        treeshake: { moduleSideEffects: (id: string) => !/[\\/](@codemirror|@lezer|codemirror)[\\/]|SourceEditor\.tsx$/.test(id) }
      } : {})
    }
  }
}));
