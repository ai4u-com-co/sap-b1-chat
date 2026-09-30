import { defineConfig } from "vitest/config"
import path from "node:path"

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
  // Vitest no lee el "jsx" de tsconfig (Next lo administra); para importar componentes
  // .tsx en tests, el transform de Vite (oxc) debe compilar JSX él mismo.
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 15_000,
    reporters: ["verbose"],
  },
})
