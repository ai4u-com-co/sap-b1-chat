import { NextResponse, type NextRequest } from "next/server"
import { verifyMcToken, createSession } from "@ai4u/mc-sso"
import { withApiHandler } from "@ai4u/platform/http"
import { COOKIE } from "@/app/lib/session"
import { readEnv } from "@/lib/env"

const SERVICE_ID     = "sapb1chat"
const SESSION_TTL_S  = 8 * 60 * 60
const SESSION_TTL_MS = SESSION_TTL_S * 1000

// POST binding: the SSO token arrives in the form body (never the URL), sent by
// Mission Control's /api/handoff auto-submitting form.
export const POST = withApiHandler(async (rawReq) => {
  const req = rawReq as NextRequest
  const form   = await req.formData()
  const token  = String(form.get("token") ?? "")
  const secret = readEnv("MISSION_CONTROL_SECRET")
  if (!secret) {
    return NextResponse.json({ error: "Configuración de servidor incompleta" }, { status: 500 })
  }

  const data = verifyMcToken(token, SERVICE_ID, secret)
  if (!data) {
    return NextResponse.json({ error: "Token inválido o expirado" }, { status: 401 })
  }

  // Propaga identidad+permisos embebidos por el handoff de MC a la sesión local.
  const sessionToken = createSession(data.tenantId, secret, SESSION_TTL_MS, {
    userId: data.userId,
    roles: data.roles,
    allowedModules: data.allowedModules,
    displayName: data.displayName,
  })
  // 303 so the browser follows the redirect as GET (not re-POSTing to "/").
  const res = NextResponse.redirect(new URL("/", req.url), 303)
  res.cookies.set(COOKIE, sessionToken, {
    httpOnly: true,
    secure:   process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge:   SESSION_TTL_S,
    path:     "/",
  })
  return res
}, { label: "POST mc-auth" }) as (req: NextRequest) => Promise<Response>
