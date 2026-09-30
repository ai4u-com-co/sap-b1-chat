import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider"

/**
 * Las tools SAP del chat (BackendClient de @ai4u/contracts) y /api/me deben pegarle al
 * gateway por la MISMA fuente: `getBackendUrl()` (SAP_BACKEND_URL → alias legados).
 * route.ts se la pasa a BackendClient como `baseUrl`; si alguien la quita, BackendClient
 * volvería a resolver por su cuenta con su propia lista de alias (más corta que la de
 * @ai4u/config: no incluye SAP_B1_BACKEND_URL) y podría divergir de /api/me.
 */

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

beforeEach(() => {
  for (const k of URL_ENV) delete process.env[k]
  gatewayCalls = []
  const realFetch = globalThis.fetch
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    if (url.includes("/api/v1/")) {
      gatewayCalls.push(url)
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
