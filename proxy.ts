import { NextRequest, NextResponse } from "next/server"
import { verifySession } from "@ai4u/mc-sso"
import { readEnv } from "@/lib/env"

// mc-auth is the SSO handoff endpoint — always public
const PUBLIC_PATHS = ["/api/mc-auth", "/_next", "/favicon"]

const COOKIE = "sap_chat_session"

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl

  if (PUBLIC_PATHS.some(p => pathname.startsWith(p))) return NextResponse.next()

  const secret = readEnv("MISSION_CONTROL_SECRET") ?? ""

  // In production, a missing secret is a misconfiguration — fail closed.
  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      return NextResponse.json({ error: "Servidor no configurado" }, { status: 500 })
    }
    return NextResponse.next()
  }

  const token = req.cookies.get(COOKIE)?.value ?? ""
  const valid = verifySession(token, secret)

  if (valid) return NextResponse.next()

  // No valid session: API calls → 401, pages → lock screen (handled by page.tsx)
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 })
  }
  return NextResponse.next() // Page shows lock screen via client-side /api/me check
}

export const proxyConfig = {
  matcher: ["/((?!_next/static|_next/image|favicon).*)"],
}
