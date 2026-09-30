import { defineConfig, globalIgnores } from "eslint/config"
import nextVitals from "eslint-config-next/core-web-vitals"
import nextTs from "eslint-config-next/typescript"

// eslint-config-next 16 exporta flat config nativo (ya no hace falta FlatCompat
// de @eslint/eslintrc). Mismos presets que antes: core-web-vitals + typescript.
const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // eslint-config-next 16 trae eslint-plugin-react-hooks v7 con reglas nuevas
    // del React Compiler. Marcan patrones que YA existían en el código (refs
    // escritos en render en app/page.tsx, setState síncrono en efectos de
    // app/hooks/*) y que funcionan hoy. Quedan como warning (deuda visible) en
    // vez de error para no mezclar refactors de comportamiento en el bump de Next.
    rules: {
      "react-hooks/refs": "warn",
      "react-hooks/set-state-in-effect": "warn",
    },
  },
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts"]),
])

export default eslintConfig
