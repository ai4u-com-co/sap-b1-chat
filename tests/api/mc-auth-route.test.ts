import { randomBytes } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createMcToken, verifySession } from "@ai4u/mc-sso"
import { POST } from "@/app/api/mc-auth/route"

// Secretos generados en runtime: ningún valor fijo que parezca credencial.
const SECRET = randomBytes(24).toString("hex")
const OTHER  = randomBytes(24).toString("hex")

function post(token?: string) {
  const body = new URLSearchParams()
  if (token !== undefined) body.set("token", token)
  return new Request("https://chat.example.com/api/mc-auth", {
    method:  "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  })
}

function sessionCookie(res: Response): { value: string; attrs: string } | null {
  const raw = res.headers.get("set-cookie") ?? ""
  const m = raw.match(/(?:^|,\s*)mc_session=([^;]*)(.*)$/)
  return m ? { value: m[1], attrs: m[2] } : null
}

describe("POST /api/mc-auth (receptor SSO)", () => {
  beforeEach(() => vi.stubEnv("MISSION_CONTROL_SECRET", SECRET))
  afterEach(() => vi.unstubAllEnvs())

  it("token válido → 303 a / con cookie mc_session de 8 h que conserva identidad", async () => {
    const token = createMcToken("tamaprint", "sapb1chat", "Tamaprint", SECRET, {
      userId: "u-1", roles: ["admin"], allowedModules: ["chat"],
    })
    const res = await POST(post(token))
    expect(res.status).toBe(303)
    expect(res.headers.get("location")).toBe("https://chat.example.com/")
    const c = sessionCookie(res)
    expect(c).not.toBeNull()
    expect(c!.attrs).toMatch(/Max-Age=28800/)
    expect(c!.attrs).toMatch(/HttpOnly/)
    expect(c!.attrs).toMatch(/SameSite=Lax/)
    expect(c!.attrs).toMatch(/Path=\//)
    const session = verifySession(c!.value, SECRET)
    expect(session).toMatchObject({
      tenantId: "tamaprint", displayName: "Tamaprint", userId: "u-1", roles: ["admin"], allowedModules: ["chat"],
    })
    expect(session!.exp - session!.iat).toBe(8 * 60 * 60 * 1000)
  })

  it("token firmado con otro secreto → 401 sin cookie", async () => {
    const res = await POST(post(createMcToken("tamaprint", "sapb1chat", "Tamaprint", OTHER)))
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: "Token inválido o expirado" })
    expect(sessionCookie(res)).toBeNull()
  })

  it("token de otro servicio → 401", async () => {
    const res = await POST(post(createMcToken("tamaprint", "otroservicio", "Tamaprint", SECRET)))
    expect(res.status).toBe(401)
  })

  it("sin token → 401", async () => {
    expect((await POST(post())).status).toBe(401)
  })

  it("sin MISSION_CONTROL_SECRET → 500 genérico (fail-closed)", async () => {
    vi.stubEnv("MISSION_CONTROL_SECRET", "")
    const res = await POST(post("x.y"))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: "Configuración de servidor incompleta" })
  })
})
