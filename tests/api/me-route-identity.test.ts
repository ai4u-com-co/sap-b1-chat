import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

/**
 * Fase 3 — /api/me manda la identidad OIDC al gateway (`x-ai4u-identity`) sin tocar
 * X-API-Key ni la URL. Se usa el helper REAL de @ai4u/platform/gateway-identity; solo
 * se reemplaza la fuente del token (`getToken`) y se acorta el timeout.
 */
const tokenSource = vi.hoisted(() => ({ fn: (async () => "") as (o: { audience: string }) => Promise<string> }))
vi.mock("@ai4u/platform/gateway-identity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ai4u/platform/gateway-identity")>()
  const silent = { warn: () => {}, debug: () => {} }
  return {
    ...actual,
    getGatewayIdentityHeaders: (opts: Parameters<typeof actual.getGatewayIdentityHeaders>[0] = {}) =>
      actual.getGatewayIdentityHeaders({
        timeoutMs: 50,
        logger: silent,
        ...opts,
        getToken: opts.getToken ?? ((o) => tokenSource.fn(o)),
      }),
  }
})

// Valores de prueba armados en runtime (nunca literales con forma de secreto).
const KEY = ["k", "test", "me"].join("-")
const TOKEN = ["tok", "oidc", "test"].join(".")
const GW = ["https:", "", "gw.example.test"].join("/")

vi.mock("@/app/lib/session", () => ({
  getApiKey: async () => KEY,
  getTenantId: async () => "tamaprint",
}))

describe("GET /api/me → x-ai4u-identity hacia el gateway (fail-open)", () => {
  const fetchMock = vi.fn()
  const prevUrl = process.env.SAP_BACKEND_URL

  beforeEach(() => {
    process.env.SAP_BACKEND_URL = GW
    fetchMock.mockReset()
    fetchMock.mockResolvedValue(Response.json({ tenant: "tamaprint", name: "Tamaprint" }))
    vi.stubGlobal("fetch", fetchMock)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    if (prevUrl === undefined) delete process.env.SAP_BACKEND_URL
    else process.env.SAP_BACKEND_URL = prevUrl
  })

  const callMe = async () => {
    const { GET } = await import("@/app/api/me/route")
    const res = await (GET as unknown as (req: Request) => Promise<Response>)(new Request("http://localhost/api/me"))
    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${GW}/api/v1/me`)
    expect(init.cache).toBe("no-store")
    return init.headers
  }

  it("con token: agrega x-ai4u-identity sin tocar X-API-Key", async () => {
    let audience = ""
    tokenSource.fn = async (o) => {
      audience = o.audience
      return TOKEN
    }
    expect(await callMe()).toEqual({ "X-API-Key": KEY, "x-ai4u-identity": TOKEN })
    expect(audience).toBe("https://sap-b1-backend.ai4u")
  })

  it.each([
    ["error del intercambio", async () => Promise.reject(new Error("sin contexto OIDC"))],
    ["timeout", () => new Promise<string>(() => {})],
    ["token vacío", async () => ""],
  ])("sin token (%s): la llamada sale idéntica a hoy", async (_caso, fn) => {
    tokenSource.fn = fn as (o: { audience: string }) => Promise<string>
    expect(await callMe()).toEqual({ "X-API-Key": KEY })
  })
})
