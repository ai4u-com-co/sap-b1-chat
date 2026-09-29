import { describe, it, expect, vi } from "vitest"
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider"

/**
 * Regresión de la verificación en producción del 29-sep (request e83c2ade):
 * la sesión y los mensajes se guardaron, pero chat_tool_calls quedó en 0 filas y
 * ningún error de persistencia llegó a platform_logs. Tres bugs:
 *   1. durationMs del SDK trae decimales y duration_ms es integer → 22P02 en TODO insert.
 *   2. onFinish usaba toolCalls del último paso (vacío) → metadata.toolCalls = [].
 *   3. Los logs emitidos durante el stream nunca se subían (withApiHandler hace
 *      flush antes de devolver el Response de streaming).
 * Este test corre el handler real con un modelo que llama una tool y una base simulada.
 */

process.env.MISSION_CONTROL_SECRET = "test-internal-secret-traza"
process.env.BACKEND_URL = "http://127.0.0.1:4100" // sin listener: la tool falla rápido, igual dispara el callback

type Insert = { table: string; row: Record<string, unknown> }
const inserts: Insert[] = []
const flushOrder: string[] = []

vi.mock("@/lib/supabase", () => {
  const table = (name: string) => ({
    insert: (row: Record<string, unknown>) => {
      inserts.push({ table: name, row })
      return Promise.resolve({ error: null })
    },
    upsert: (row: Record<string, unknown>) => {
      inserts.push({ table: name, row })
      return Promise.resolve({ error: null })
    },
  })
  return { supabase: { from: table } }
})

vi.mock("@ai4u/platform/logger", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@ai4u/platform/logger")>()
  return {
    ...mod,
    flushLogs: vi.fn(async () => {
      flushOrder.push(`flush@${inserts.filter((i) => i.table === "chat_tool_calls").length}`)
    }),
  }
})

vi.mock("@ai-sdk/anthropic", async () => {
  const { MockLanguageModelV3, convertArrayToReadableStream } = await import("ai/test")
  let call = 0
  const usage = { inputTokens: { total: 1 }, outputTokens: { total: 1 } }
  const mockModel = new MockLanguageModelV3({
    doStream: async () => {
      call++
      const chunks = (
          call === 1
            ? [
                { type: "stream-start", warnings: [] },
                { type: "tool-call", toolCallId: "call_1", toolName: "consultar_sql", input: JSON.stringify({ sql: "SELECT COUNT(*) AS N FROM OINV WHERE CANCELED = 'N'" }) },
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

describe("trazabilidad del turno: chat_tool_calls, metadata y flush de logs", () => {
  it("guarda la tool call (duración entera + request_id), los toolCalls de todos los pasos y sube los logs al terminar", async () => {
    const { POST } = await import("@/app/api/chat/route")
    const req = new Request("http://localhost/api/chat", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-secret": "test-internal-secret-traza",
        "x-tenant-id": "flexoimpresos",
        "x-api-key": "test-sap-key",
        "x-user-id": "831d395c-c376-4e00-9e55-11aea57245f4",
        "x-request-id": "rid-traza",
      },
      body: JSON.stringify({
        sessionId: "tabc123",
        messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "¿cuántas facturas hay?" }] }],
      }),
    })

    const res = await POST(req)
    await res.text() // consumir el stream completo

    // 1. tool call persistida con duración ENTERA (antes: float → 22P02) y request_id
    const tc = inserts.filter((i) => i.table === "chat_tool_calls")
    expect(tc).toHaveLength(1)
    expect(tc[0].row.tool_name).toBe("consultar_sql")
    expect(Number.isInteger(tc[0].row.duration_ms)).toBe(true)
    expect(typeof tc[0].row.request_id).toBe("string")
    expect(tc[0].row.request_id).toBeTruthy()

    // 2. el mensaje del asistente lleva los tool calls de TODOS los pasos
    const assistant = inserts.find((i) => i.table === "chat_messages" && i.row.role === "assistant")!
    const meta = assistant.row.metadata as { toolCalls: unknown[]; requestId?: string }
    expect(meta.toolCalls).toHaveLength(1)
    expect(meta.requestId).toBe(tc[0].row.request_id)

    // 3. flush de logs DESPUÉS de persistir la tool call (al terminar el turno)
    expect(flushOrder.some((f) => f === "flush@1")).toBe(true)
  })
})
