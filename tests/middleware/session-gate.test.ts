import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { createSession } from "@ai4u/mc-sso"
import { middleware, config } from "@/middleware"

const SECRET = "test-mission-control-secret"

function req(path: string, init: { cookie?: string; headers?: Record<string, string>; method?: string } = {}) {
  const headers = new Headers(init.headers)
  if (init.cookie) headers.set("cookie", `mc_session=${init.cookie}`)
  return new NextRequest(new URL(path, "https://chat.example.com"), { method: init.method ?? "GET", headers })
}

/** NextResponse.next() marca el pase con el header interno x-middleware-next. */
function passed(res: Response) {
  return res.headers.get("x-middleware-next") === "1"
}

describe("middleware (gate de sesión)", () => {
  beforeEach(() => {
    vi.stubEnv("MISSION_CONTROL_SECRET", SECRET)
    vi.stubEnv("MC_INTERNAL_SECRET", "")
    vi.stubEnv("NODE_ENV", "production")
  })
  afterEach(() => vi.unstubAllEnvs())

  it("usa la convención de Next 15: runtime nodejs y matcher solo /api", () => {
    expect(config.runtime).toBe("nodejs")
    expect(config.matcher).toEqual(["/api/:path*"])
  })

  it.each(["/api/chat", "/api/me", "/api/suggestions"])("sin sesión → 401 en %s", async (path) => {
    const res = middleware(req(path, { method: "POST" }))
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: "No autorizado" })
  })

  it("cookie con firma inválida → 401", () => {
    const forged = createSession("tamaprint", "otro-secreto")
    expect(middleware(req("/api/me", { cookie: forged })).status).toBe(401)
  })

  it("cookie expirada → 401", () => {
    const expired = createSession("tamaprint", SECRET, -1000)
    expect(middleware(req("/api/me", { cookie: expired })).status).toBe(401)
  })

  it.each(["/api/chat", "/api/me", "/api/suggestions"])("con sesión válida pasa %s", (path) => {
    const token = createSession("tamaprint", SECRET)
    expect(passed(middleware(req(path, { cookie: token })))).toBe(true)
  })

  it("/api/mc-auth es público (handoff SSO sin cookie)", () => {
    expect(passed(middleware(req("/api/mc-auth", { method: "POST" })))).toBe(true)
  })

  it("/api/changelog es público (hoy no exige sesión)", () => {
    expect(passed(middleware(req("/api/changelog?limit=5")))).toBe(true)
  })

  it("un prefijo parecido a una ruta pública NO se cuela (/api/mc-authx)", () => {
    expect(middleware(req("/api/mc-authx")).status).toBe(401)
  })

  it.each(["/api/chat", "/api/suggestions"])("S2S de Mission Control con x-internal-secret válido pasa %s", (path) => {
    const res = middleware(req(path, { method: "POST", headers: { "x-internal-secret": SECRET } }))
    expect(passed(res)).toBe(true)
  })

  it("acepta el alias legacy MC_INTERNAL_SECRET durante rotación", () => {
    vi.stubEnv("MC_INTERNAL_SECRET", "secreto-legacy")
    const res = middleware(req("/api/chat", { method: "POST", headers: { "x-internal-secret": "secreto-legacy" } }))
    expect(passed(res)).toBe(true)
  })

  it("x-internal-secret inválido sin cookie → 401", () => {
    const res = middleware(req("/api/chat", { method: "POST", headers: { "x-internal-secret": "nope" } }))
    expect(res.status).toBe(401)
  })

  it("páginas no se bloquean aunque se llame directo (la UI muestra lock screen)", () => {
    expect(passed(middleware(req("/")))).toBe(true)
  })

  it("en producción sin MISSION_CONTROL_SECRET falla cerrado (500)", () => {
    vi.stubEnv("MISSION_CONTROL_SECRET", "")
    expect(middleware(req("/api/me")).status).toBe(500)
  })

  it("en dev sin secreto deja pasar (los handlers deciden)", () => {
    vi.stubEnv("MISSION_CONTROL_SECRET", "")
    vi.stubEnv("NODE_ENV", "development")
    expect(passed(middleware(req("/api/me")))).toBe(true)
  })
})
