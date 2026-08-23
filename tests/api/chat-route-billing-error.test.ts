import { describe, it, expect, vi } from "vitest"

/**
 * Regresión del incidente 2026-08-23 (tenant tamaprint):
 *
 * Anthropic respondía `400 invalid_request_error` con "Your credit balance is
 * too low to access the Anthropic API…" porque la ORGANIZACIÓN de Anthropic
 * dueña de TAMAPRINT_ANTHROPIC_API_KEY estaba en $0. route.ts retransmitía el
 * texto crudo en inglés al usuario, y en platform_logs solo quedaba
 * "error durante streaming (Anthropic/tool loop)" sin tenant, sin status y
 * sin identificar la key — diagnóstico de ~1 h para algo que debía ser 1 log.
 *
 * Este test invoca el handler POST real con el modelo mockeado para que el
 * stream emita un APICallError 400 de billing, y verifica que:
 *   1. el chunk `type:"error"` que llega al cliente está en español, nombra al
 *      tenant y CONSERVA el texto crudo de Anthropic (no se pierde información);
 *   2. el log de error lleva `anthropicCode: "ANTHROPIC_BILLING"`, status 400,
 *      `keyFingerprint` con formato del Console y `keyEnv`.
 */

const BILLING_MSG =
  "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."
const FAKE_KEY = "sk-ant-api03-Ens" + "Z".repeat(88) + "1gAA"

process.env.MISSION_CONTROL_SECRET = "test-internal-secret-billing"
process.env.BACKEND_URL = "http://127.0.0.1:4100"
process.env.TAMAPRINT_ANTHROPIC_API_KEY = FAKE_KEY
delete process.env.NEXT_PUBLIC_SUPABASE_URL
delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

// Captura de lo que route.ts manda a apiCtx.log.* (el logger real de
// @ai4u/platform); se deja pasar todo lo demás de withApiHandler intacto.
const logged: Array<{ level: string; data: unknown; msg: string }> = []
vi.mock("@ai4u/platform/http", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@ai4u/platform/http")>()
  return {
    ...mod,
    withApiHandler: (handler: (req: Request, ctx: unknown) => Promise<Response>, opts: unknown) =>
      mod.withApiHandler(async (req: Request, ctx: { log: Record<string, unknown> }) => {
        const wrap = (level: string) => (data: unknown, msg: string) => logged.push({ level, data, msg })
        const fakeCtx = { ...ctx, log: { ...ctx.log, error: wrap("error"), warn: wrap("warn"), info: wrap("info") } }
        return handler(req, fakeCtx)
      }, opts as never),
  }
})

vi.mock("@ai-sdk/anthropic", async () => {
  const { MockLanguageModelV3, convertArrayToReadableStream } = await import("ai/test")
  const { APICallError } = await import("@ai-sdk/provider")
  const billingError = new APICallError({
    message: BILLING_MSG,
    url: "https://api.anthropic.com/v1/messages",
    requestBodyValues: {},
    statusCode: 400,
    responseBody: JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: BILLING_MSG } }),
    isRetryable: false,
  })
  const mockModel = new MockLanguageModelV3({
    doStream: async () => ({
      stream: convertArrayToReadableStream([
        { type: "stream-start", warnings: [] },
        { type: "error", error: billingError },
      ]),
    }),
  })
  return { createAnthropic: () => () => mockModel }
})

describe("incidente 2026-08-23: 400 billing de Anthropic", () => {
  it("el usuario recibe mensaje en español con tenant + crudo, y el log queda clasificado con fingerprint de key", async () => {
    const { POST } = await import("@/app/api/chat/route")
    const req = new Request("http://localhost/api/chat", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-secret": "test-internal-secret-billing",
        "x-tenant-id": "tamaprint",
        "x-api-key": "test-sap-key",
      },
      body: JSON.stringify({
        messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "¿Cómo van las ventas de hoy?" }] }],
      }),
    })

    const res = await POST(req)
    expect(res.status).toBe(200)
    const raw = await res.text()
    const errorLine = raw.split("\n").find((l) => l.startsWith("data: ") && l.includes('"type":"error"'))
    expect(errorLine, `sin chunk type:error. Raw:\n${raw}`).toBeTruthy()
    const payload = JSON.parse(errorLine!.slice("data: ".length))

    // 1. Mensaje al usuario
    expect(payload.errorText).toContain("tamaprint")
    expect(payload.errorText).toContain("no tiene crédito")
    expect(payload.errorText).toContain(BILLING_MSG)
    expect(payload.errorText).not.toBe("An error occurred.")

    // 2. Log clasificado (cualquiera de los dos onError de route.ts)
    const errLogs = logged.filter((l) => l.level === "error")
    expect(errLogs.length).toBeGreaterThan(0)
    const billing = errLogs.find((l) => (l.data as { anthropicCode?: string }).anthropicCode === "ANTHROPIC_BILLING")
    expect(billing, `ningún log con anthropicCode=ANTHROPIC_BILLING. Logs:\n${JSON.stringify(logged, null, 1)}`).toBeTruthy()
    const d = billing!.data as Record<string, unknown>
    expect(d.anthropicStatus).toBe(400)
    expect(d.anthropicType).toBe("invalid_request_error")
    expect(d.tenantId).toBe("tamaprint")
    expect(d.keyEnv).toBe("TAMAPRINT_ANTHROPIC_API_KEY")
    expect(d.keySource).toBe("tenant")
    expect(d.keyFingerprint).toBe("sk-ant-api03-Ens…1gAA")
    expect(billing!.msg).toContain("[ANTHROPIC_BILLING]")
    // La key completa jamás va al log
    expect(JSON.stringify(logged)).not.toContain(FAKE_KEY)

    // 3. El log de resolución de key salió al inicio del request
    const resolved = logged.find((l) => l.msg.includes("key de Anthropic resuelta"))
    expect(resolved).toBeTruthy()
    expect((resolved!.data as Record<string, unknown>).keyFingerprint).toBe("sk-ant-api03-Ens…1gAA")
  })
})
