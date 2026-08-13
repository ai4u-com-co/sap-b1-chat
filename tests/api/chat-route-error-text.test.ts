import { describe, it, expect, vi } from "vitest"

/**
 * FLX-082 — regresión de causa raíz confirmada:
 *
 *   app/api/chat/route.ts:1164 llama `result.toUIMessageStream({ sendReasoning: true })`
 *   SIN `onError`. El default de la librería `ai` (v6.0.191,
 *   node_modules/ai/src/generate-text/stream-text.ts:2522 y
 *   node_modules/ai/src/generate-text/stream-text.ts:2807-2814) es
 *   `onError = () => 'An error occurred.'`, así que CUALQUIER error ocurrido
 *   durante el streaming de Anthropic (overloaded, no-output, etc.) llega al
 *   cliente como el string literal genérico "An error occurred." en vez del
 *   detalle real — exactamente lo que se vio en producción el 13/08/2026
 *   08:39:47 UTC para el tenant flexo (AI_NoOutputGeneratedError perdido).
 *
 * Este test mockea el modelo de Anthropic (vía `@ai-sdk/anthropic`) para que
 * el stream falle a mitad de camino con un error de mensaje distintivo, invoca
 * el handler POST real de app/api/chat/route.ts, y verifica que el part de
 * error emitido en el UI message stream contenga ese mensaje — no el genérico.
 *
 * NO se mockea `streamText`: se deja correr la implementación real de `ai`
 * (incluyendo el propio `toUIMessageStream` que route.ts llama sin `onError`),
 * y solo se sustituye el modelo subyacente por un MockLanguageModelV3 de
 * `ai/test`, para que la reproducción sea fiel al mecanismo diagnosticado.
 */

const DISTINCTIVE_ERROR = "overloaded_error: test simulation FLX-082"

// ── Env mínimo para que el handler no rechace la request en el gate de auth
// interno (resolveAuth) ni intente pegarle a Supabase real. ─────────────────
process.env.MISSION_CONTROL_SECRET = "test-internal-secret-flx082"
// Puerto sin listener real: BackendClient (SAP) falla rápido con conexión
// rechazada, y el código de fetchSapContext/catalogList ya swallowea ese
// error (try/catch → [] / null) — no forma parte del mecanismo bajo prueba.
process.env.BACKEND_URL = "http://127.0.0.1:4100"
delete process.env.NEXT_PUBLIC_SUPABASE_URL
delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

vi.mock("@ai-sdk/anthropic", async () => {
  const { MockLanguageModelV3, convertArrayToReadableStream } = await import("ai/test")
  const mockModel = new MockLanguageModelV3({
    doStream: async () => ({
      stream: convertArrayToReadableStream([
        { type: "stream-start", warnings: [] },
        // Simula el fallo real de Anthropic a mitad del stream (overloaded /
        // No output generated / lo que sea) — el mecanismo bajo prueba no
        // depende de CUÁL error sea, sino de que route.ts no lo preserva.
        { type: "error", error: new Error(DISTINCTIVE_ERROR) },
      ]),
    }),
  })
  return {
    createAnthropic: () => () => mockModel,
  }
})

describe("FLX-082: el error real de Anthropic se pierde tras 'An error occurred.'", () => {
  it("propaga el mensaje real del error de streaming al cliente, no el genérico de la librería", async () => {
    const { POST } = await import("@/app/api/chat/route")

    const req = new Request("http://localhost/api/chat", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-secret": "test-internal-secret-flx082",
        "x-tenant-id": "flexoimpresos",
        "x-api-key": "test-sap-key",
      },
      body: JSON.stringify({
        messages: [
          {
            id: "msg-1",
            role: "user",
            parts: [{ type: "text", text: "¿por qué la rentabilidad es negativa?" }],
          },
        ],
      }),
    })

    // POST se exporta con un type assertion a `(req: Request) => Promise<Response>`
    // (route.ts:1221, para conformar al validador de rutas tipadas de `next build`
    // — ver @ai4u/platform withApiHandler) — no acepta un segundo argumento.
    const res = await POST(req)
    expect(res.status).toBe(200)
    expect(res.body).toBeTruthy()

    const raw = await res.text()

    // El UI message stream serializa cada chunk como `data: {...}\n\n` (SSE).
    // Buscamos el chunk `{"type":"error", ...}` emitido por
    // toUIMessageStream() y extraemos su errorText.
    const errorLine = raw
      .split("\n")
      .find((line) => line.startsWith("data: ") && line.includes('"type":"error"'))

    expect(errorLine, `no se encontró ningún chunk type:"error" en el stream.\nRaw:\n${raw}`).toBeTruthy()

    const payload = JSON.parse(errorLine!.slice("data: ".length))

    // ── La aserción de la regresión ──
    // HOY (antes del fix) esto falla porque payload.errorText === "An error
    // occurred." (el default de la librería `ai` sin onError en route.ts:1164).
    expect(payload.errorText).toContain(DISTINCTIVE_ERROR)
    expect(payload.errorText).not.toBe("An error occurred.")
  })
})
