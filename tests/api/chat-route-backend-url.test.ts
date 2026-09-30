import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider"

/**
 * Las tools SAP del chat (BackendClient de @ai4u/contracts) y /api/me deben pegarle al
 * gateway por la MISMA fuente: `getBackendUrl()` (SAP_BACKEND_URL → alias legados).
 * route.ts se la pasa a BackendClient como `baseUrl`; si alguien la quita, BackendClient
 * volvería a resolver por su cuenta con su propia lista de alias (más corta que la de
 * @ai4u/config: no incluye SAP_B1_BACKEND_URL) y podría divergir de /api/me.
 *
 * Fase 3: esas mismas llamadas llevan `x-ai4u-identity` (extraHeaders de BackendClient,
 * @ai4u/contracts v0.7.0) cuando hay token OIDC, y salen idénticas a antes cuando no.
 * Se usa el helper REAL de @ai4u/platform/gateway-identity; solo se reemplaza la fuente
 * del token (`getToken`) y se acorta el timeout (mismo patrón que me-route-identity).
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

process.env.MISSION_CONTROL_SECRET = "test-internal-secret-backend-url"
delete process.env.NEXT_PUBLIC_SUPABASE_URL
delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

vi.mock("@/lib/supabase", () => {
  const table = () => ({
    insert: () => Promise.resolve({ error: null }),
    upsert: () => Promise.resolve({ error: null }),
  })
  return { supabase: { from: table } }
})

vi.mock("@ai-sdk/anthropic", async () => {
  const { MockLanguageModelV3, convertArrayToReadableStream } = await import("ai/test")
  let call = 0
  const usage = { inputTokens: { total: 1 }, outputTokens: { total: 1 } }
  const mockModel = new MockLanguageModelV3({
    doStream: async () => {
      call++
      const chunks = (
        call % 2 === 1
          ? [
              { type: "stream-start", warnings: [] },
              { type: "tool-call", toolCallId: `call_${call}`, toolName: "consultar_sql", input: JSON.stringify({ sql: "SELECT COUNT(*) AS N FROM OINV WHERE CANCELED = 'N'" }) },
              { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_use" }, usage },
            ]
          : [
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "t" },
              { type: "text-delta", id: "t", delta: "Listo." },
              { type: "text-end", id: "t" },
              { type: "finish", finishReason: { unified: "stop", raw: "end_turn" }, usage },
            ]
      ) as unknown as LanguageModelV3StreamPart[]
      return { stream: convertArrayToReadableStream(chunks) }
    },
  })
  return { createAnthropic: () => () => mockModel }
})

const URL_ENV = ["SAP_BACKEND_URL", "BACKEND_URL", "NEXT_PUBLIC_BACKEND_URL", "SAP_B1_BACKEND_URL", "KPIS_APP_URL"] as const
let gatewayCalls: string[] = []
let gatewayHeaders: Record<string, string>[] = []

beforeEach(() => {
  for (const k of URL_ENV) delete process.env[k]
  gatewayCalls = []
  gatewayHeaders = []
  tokenSource.fn = async () => ""
  const realFetch = globalThis.fetch
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    if (url.includes("/api/v1/")) {
      gatewayCalls.push(url)
      gatewayHeaders.push({ ...(init?.headers as Record<string, string>) })
      // Sin gateway real: conexión rechazada, igual que un puerto sin listener.
      throw new TypeError("fetch failed")
    }
    return realFetch(input, init)
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  for (const k of URL_ENV) delete process.env[k]
})

async function runTurn() {
  const { POST } = await import("@/app/api/chat/route")
  const req = new Request("http://localhost/api/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-internal-secret": "test-internal-secret-backend-url",
      "x-tenant-id": "flexoimpresos",
      "x-api-key": "test-sap-key",
      "x-user-id": "831d395c-c376-4e00-9e55-11aea57245f4",
    },
    body: JSON.stringify({
      messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "¿cuántas facturas hay?" }] }],
    }),
  })
  const res = await POST(req)
  await res.text()
}

describe("URL del gateway en las tools SAP del chat", () => {
  it("usa SAP_BACKEND_URL aunque haya alias legados con otro valor", async () => {
    process.env.SAP_BACKEND_URL = "http://canonico.test:4100"
    process.env.BACKEND_URL = "http://legado.test:4100"
    process.env.NEXT_PUBLIC_BACKEND_URL = "http://publico.test:4100"

    await runTurn()

    expect(gatewayCalls.length).toBeGreaterThan(0)
    for (const url of gatewayCalls) expect(url.startsWith("http://canonico.test:4100/api/v1/flexoimpresos")).toBe(true)
  })

  it("alias legado BACKEND_URL sigue funcionando si no hay SAP_BACKEND_URL", async () => {
    process.env.BACKEND_URL = "http://legado.test:4100"

    await runTurn()

    expect(gatewayCalls.length).toBeGreaterThan(0)
    for (const url of gatewayCalls) expect(url.startsWith("http://legado.test:4100/api/v1/flexoimpresos")).toBe(true)
  })

  it("alias que solo conoce @ai4u/config (SAP_B1_BACKEND_URL) llega igual a BackendClient vía baseUrl", async () => {
    process.env.SAP_B1_BACKEND_URL = "http://alias-config.test:4100"

    await runTurn()

    expect(gatewayCalls.length).toBeGreaterThan(0)
    for (const url of gatewayCalls) expect(url.startsWith("http://alias-config.test:4100/api/v1/flexoimpresos")).toBe(true)
  })
})

describe("identidad OIDC (x-ai4u-identity) en las tools SAP del chat", () => {
  // Armado en runtime (nunca un literal con forma de secreto).
  const TOKEN = ["tok", "oidc", "chat"].join(".")
  // Lo que BackendClient mandaba antes de extraHeaders (v0.6.1), sin nada más.
  const BASE_HEADERS = ["Content-Type", "X-API-Key", "x-mc-secret", "x-request-id", "x-consumer"].sort()

  const expectBase = (h: Record<string, string>) => {
    expect(h["X-API-Key"]).toBe("test-sap-key")
    expect(h["x-consumer"]).toBe("sap-b1-chat")
    expect(h["x-mc-secret"]).toBe("test-internal-secret-backend-url")
    expect(typeof h["x-request-id"]).toBe("string")
  }

  it("con token: cada llamada de BackendClient lleva x-ai4u-identity sin tocar auth ni trazabilidad", async () => {
    process.env.SAP_BACKEND_URL = "http://canonico.test:4100"
    const audiences: string[] = []
    tokenSource.fn = async (o) => {
      audiences.push(o.audience)
      return TOKEN
    }

    await runTurn()

    expect(gatewayHeaders.length).toBeGreaterThan(0)
    for (const h of gatewayHeaders) {
      expectBase(h)
      expect(h["x-ai4u-identity"]).toBe(TOKEN)
      expect(Object.keys(h).sort()).toEqual([...BASE_HEADERS, "x-ai4u-identity"].sort())
    }
    // Se evalúa por request (no se cachea en el cliente): una resolución por llamada.
    expect(audiences.length).toBe(gatewayHeaders.length)
    for (const a of audiences) expect(a).toBe("https://sap-b1-backend.ai4u")
  })

  it.each([
    ["error del intercambio", async () => Promise.reject(new Error("sin contexto OIDC"))],
    ["timeout", () => new Promise<string>(() => {})],
    ["token vacío", async () => ""],
  ])("sin token (%s): las llamadas salen idénticas a antes", async (_caso, fn) => {
    process.env.SAP_BACKEND_URL = "http://canonico.test:4100"
    tokenSource.fn = fn as (o: { audience: string }) => Promise<string>

    await runTurn()

    expect(gatewayHeaders.length).toBeGreaterThan(0)
    for (const h of gatewayHeaders) {
      expectBase(h)
      expect(Object.keys(h).sort()).toEqual(BASE_HEADERS)
    }
  })
})
