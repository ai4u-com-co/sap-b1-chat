import type { NextRequest } from "next/server"
import { sessionGate } from "@/lib/session-gate"

// Next 15: el archivo DEBE llamarse `middleware.ts` y exportar `middleware` +
// `config` (`proxy.ts`/`proxyConfig` es la convención de Next 16 y en 15 se
// ignora en silencio — por eso el gate no corría).
export function middleware(req: NextRequest) {
  return sessionGate(req)
}

export const config = {
  // Runtime Node (estable desde Next 15.5): @ai4u/mc-sso usa `node:crypto`,
  // que no existe en el runtime edge.
  runtime: "nodejs",
  // Solo /api: las páginas y assets no necesitan el gate (la UI muestra la
  // pantalla de bloqueo con /api/me) y así no se paga una invocación por asset.
  matcher: ["/api/:path*"],
}
