import { defineConfig } from "vitest/config"
import path from "node:path"

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
  // tsconfig usa "jsx": "preserve" (lo exige Next); para importar componentes
  // .tsx en tests, el transform de Vite (oxc) debe compilar JSX él mismo.
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 15_000,
    reporters: ["verbose"],
  },
})
