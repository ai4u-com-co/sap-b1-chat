import type { NextRequest } from "next/server"
import { sessionGate } from "@/lib/session-gate"

// Next 16: el archivo se llama `proxy.ts`, exporta `proxy` y Next lee el
// matcher de `config` (no `proxyConfig`, que se ignora en silencio). El proxy
// corre SIEMPRE en runtime Node (no configurable: declarar `runtime` acá rompe
// el build), que es lo que necesita @ai4u/mc-sso (`node:crypto`).
export function proxy(req: NextRequest) {
  return sessionGate(req)
}

export const config = {
  // Solo /api: las páginas y assets no necesitan el gate (la UI muestra la
  // pantalla de bloqueo con /api/me) y así no se paga una invocación por asset.
  matcher: ["/api/:path*"],
}
