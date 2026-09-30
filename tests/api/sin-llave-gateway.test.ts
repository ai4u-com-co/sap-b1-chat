import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

/**
 * Sin respaldo "S2S_AUTH": un tenant de la sesión sin {TENANT}_SAP_API_KEY
 *  - SAP (tamaprint/flexoimpresos): fail-closed, 401 y NUNCA llama al gateway.
 *  - proxy (magdalena): sigue funcionando igual que antes (no usa la llave del gateway).
 * Antes getApiKey devolvía "S2S_AUTH" y el gateway autenticaba por x-mc-secret.
 */

const session = vi.hoisted(() => ({ tenantId: "tamaprint" as string | null, apiKey: null as string | null }))
vi.mock("@/app/lib/session", () => ({
  getTenantId: async () => session.tenantId,
  getApiKey: async () => session.apiKey,
}))

vi.mock("@/lib/supabase", () => ({ supabase: null }))

const PROXY_URL = ["https:", "", "magdalena.example.test", "api", "chat"].join("/")

describe("sin llave del gateway (sin respaldo S2S_AUTH)", () => {
  const fetchMock = vi.fn()
  const prevMagdalena = process.env.MAGDALENA_CHAT_URL

  beforeEach(() => {
    session.tenantId = "tamaprint"
    session.apiKey = null
    process.env.MAGDALENA_CHAT_URL = PROXY_URL
    fetchMock.mockReset()
    fetchMock.mockResolvedValue(new Response("data: ok\n\n", { headers: { "Content-Type": "text/event-stream" } }))
    vi.stubGlobal("fetch", fetchMock)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    if (prevMagdalena === undefined) delete process.env.MAGDALENA_CHAT_URL
    else process.env.MAGDALENA_CHAT_URL = prevMagdalena
  })

  const post = (path: string, body: unknown) =>
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })

  it("/api/chat, tenant SAP sin llave → 401 sin llamar al gateway", async () => {
    const { POST } = await import("@/app/api/chat/route")
    const res = await POST(post("/api/chat", { messages: [] }))
    expect(res.status).toBe(401)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("/api/chat, tenant proxy (magdalena) sin llave → se sigue enviando a su backend", async () => {
    session.tenantId = "magdalena"
    const { POST } = await import("@/app/api/chat/route")
    const res = await POST(post("/api/chat", { messages: [] }))
    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(PROXY_URL)
    expect(JSON.stringify(init.headers)).not.toContain("S2S_AUTH")
  })

  it("/api/suggestions, tenant SAP sin llave → 401", async () => {
    const { POST } = await import("@/app/api/suggestions/route")
    const res = await (POST as unknown as (req: Request) => Promise<Response>)(post("/api/suggestions", {}))
    expect(res.status).toBe(401)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("/api/suggestions, tenant proxy sin llave → sugerencias estáticas", async () => {
    session.tenantId = "magdalena"
    const { POST } = await import("@/app/api/suggestions/route")
    const res = await (POST as unknown as (req: Request) => Promise<Response>)(post("/api/suggestions", {}))
    expect(res.status).toBe(200)
    expect((await res.json()).source).toBe("static")
  })

  it("/api/me sin llave → nombre de fallback, sin llamar al gateway ni mandar S2S_AUTH", async () => {
    session.tenantId = "magdalena"
    const { GET } = await import("@/app/api/me/route")
    const res = await (GET as unknown as (req: Request) => Promise<Response>)(new Request("http://localhost/api/me"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ tenant: "magdalena", name: "magdalena" })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("/api/me sin sesión → 401", async () => {
    session.tenantId = null
    const { GET } = await import("@/app/api/me/route")
    const res = await (GET as unknown as (req: Request) => Promise<Response>)(new Request("http://localhost/api/me"))
    expect(res.status).toBe(401)
  })
})
