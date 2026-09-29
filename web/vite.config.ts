import { writeFileSync } from "node:fs";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";

// Where `vite` (dev) forwards server calls: the Go binary from `make run`.
const backend = process.env.BACKEND_URL ?? "http://localhost:8080";

export default defineConfig({
  // The router plugin regenerates src/routeTree.gen.ts on dev and build, so route files added by the optional
  // assistant overlay are picked up without a manual step. It must come before the React plugin.
  plugins: [
    tanstackRouter({ target: "react", autoCodeSplitting: true }),
    react(),
    tailwindcss(),
    {
      // web/dist is emptied on every build; dist/.gitkeep is committed so `//go:embed all:dist` compiles on a fresh clone.
      name: "keep-dist-gitkeep",
      apply: "build",
      closeBundle() {
        writeFileSync("dist/.gitkeep", "");
      },
    },
  ],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    proxy: {
      "/api": backend,
      "/auth": backend,
      "/healthz": backend,
      "/openapi.json": backend,
    },
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}", "test/**/*.test.ts"],
    css: false,
  },
});
