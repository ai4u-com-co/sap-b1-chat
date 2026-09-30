import { NextResponse, type NextRequest } from "next/server"
import { verifySession } from "@ai4u/mc-sso"
import { readEnv } from "@/lib/env"
import { verifyInternalSecret } from "@/lib/internal-auth"
import { COOKIE } from "@/app/lib/session"

/**
 * Gate central de sesión para `/api/*` (lo ejecuta `proxy.ts`).
 *
 * Es una capa ADICIONAL: cada handler sigue validando sesión por su cuenta
 * (defensa en profundidad). El gate no puede ser más estricto que los handlers
 * sin romper algo que hoy funciona, por eso deja pasar exactamente lo que los
 * handlers aceptan:
 *
 *  - Rutas públicas (sin sesión por diseño):
 *      /api/mc-auth    → recibe el handoff SSO de Mission Control (aún no hay cookie).
 *      /api/changelog  → proxy de solo lectura al changelog-service; hoy no exige sesión.
 *  - Llamadas servidor-a-servidor de Mission Control con `x-internal-secret`
 *    válido (/api/chat y /api/suggestions las aceptan sin cookie).
 *  - Cookie `mc_session` firmada y vigente.
 *
 * Lo demás bajo /api → 401. Las páginas no pasan por acá: el matcher solo cubre
 * /api y la página muestra la pantalla de bloqueo vía `/api/me`.
 */
export const PUBLIC_API_PATHS = ["/api/mc-auth", "/api/changelog"] as const

function isPublicApiPath(pathname: string): boolean {
  return PUBLIC_API_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))
}

export function sessionGate(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl

  if (!pathname.startsWith("/api/") || isPublicApiPath(pathname)) return NextResponse.next()

  const secret = readEnv("MISSION_CONTROL_SECRET") ?? ""

  // Sin secreto en producción es una mala configuración → fallar cerrado.
  // En dev (sin secreto) se deja pasar, igual que antes; los handlers deciden.
  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      return NextResponse.json({ error: "Servidor no configurado" }, { status: 500 })
    }
    return NextResponse.next()
  }

  // Servidor-a-servidor (Mission Control): mismo criterio que los handlers.
  if (verifyInternalSecret(req.headers.get("x-internal-secret"))) return NextResponse.next()

  const token = req.cookies.get(COOKIE)?.value ?? ""
  if (verifySession(token, secret)) return NextResponse.next()

  return NextResponse.json({ error: "No autorizado" }, { status: 401 })
}
