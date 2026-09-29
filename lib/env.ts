// Punto ÚNICO de lectura de variables de entorno de la app.
//
// El contrato de nombres (canónicos, alias con aviso, llaves por tenant) vive en
// @ai4u/config/env — ver su README. Nunca leer `process.env.X` suelto en el resto
// de la app: si falta un nombre, agregarlo al contrato (kernel) o leerlo con
// `readEnv("NOMBRE_PROPIO")`, que también acepta variables propias de la app.
//
// Excepción: las `NEXT_PUBLIC_*` que lee un componente cliente (ChangelogPill)
// siguen con acceso literal `process.env.NEXT_PUBLIC_X`, porque Next.js solo las
// inlinea en el bundle del navegador así.
import {
  loadEnv as loadEnvFromContract,
  type EnvName,
  type LoadEnvSpec,
  type LoadedEnv,
} from "@ai4u/config/env"

export * from "@ai4u/config/env"

/**
 * Igual que `loadEnv` del contrato, pero solo es estricto (lanza si falta una
 * obligatoria) en Production de Vercel. Los Preview corren con NODE_ENV=production
 * y no tienen los secretos de producción a propósito: ahí solo avisa.
 */
export function loadEnv<R extends EnvName = never, O extends EnvName = never>(
  spec: LoadEnvSpec<R, O>,
): LoadedEnv<R, O> {
  return loadEnvFromContract({ production: process.env.VERCEL_ENV === "production", ...spec })
}
