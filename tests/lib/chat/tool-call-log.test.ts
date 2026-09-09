import { describe, it, expect, vi } from "vitest"
import { buildToolCallLogRow, logToolCallResult, type ToolCallLogRow } from "@/lib/chat/tool-call-log"

/**
 * Fix #2 del incidente 2026-08-31: trazabilidad incremental vía
 * `experimental_onToolCallFinish` (route.ts) — ver comentario del módulo en
 * lib/chat/tool-call-log.ts. Estos tests cubren la función pura (sin Supabase)
 * y el wrapper best-effort de inserción.
 */
describe("buildToolCallLogRow", () => {
  const base = {
    sessionId: "s1",
    tenantId: "flexoimpresos",
    toolName: "consultar_sql",
    toolCallId: "call_123",
    stepNumber: 2,
    durationMs: 842,
    input: { sql: "SELECT * FROM OINV" },
  }

  it("success=true cuando la tool respondió normal (sin shape de error)", () => {
    const row = buildToolCallLogRow({
      ...base,
      sdkSuccess: true,
      output: { rows: [{ DocEntry: 1 }], count: 1 },
    })
    expect(row.success).toBe(true)
    expect(row.output).toEqual({ rows: [{ DocEntry: 1 }], count: 1 })
    expect(row.session_id).toBe("s1")
    expect(row.tenant_id).toBe("flexoimpresos")
    expect(row.tool_name).toBe("consultar_sql")
    expect(row.tool_call_id).toBe("call_123")
    expect(row.step_number).toBe(2)
    expect(row.duration_ms).toBe(842)
  })

  it("success=false cuando la tool devolvió { error: {...} } como retorno normal (patrón classifySapError) aunque el SDK diga sdkSuccess=true", () => {
    const row = buildToolCallLogRow({
      ...base,
      sdkSuccess: true,
      output: { error: { code: "SAP_TIMEOUT", message: "SAP B1 no respondió en el tiempo esperado.", retryable: true } },
    })
    expect(row.success).toBe(false)
    expect(row.output).toEqual({ error: { code: "SAP_TIMEOUT", message: "SAP B1 no respondió en el tiempo esperado.", retryable: true } })
  })

  it("success=false y output={thrown:...} cuando la tool realmente tiró (sdkSuccess=false)", () => {
    const row = buildToolCallLogRow({
      ...base,
      sdkSuccess: false,
      error: new Error("boom inesperado"),
    })
    expect(row.success).toBe(false)
    expect(row.output).toEqual({ thrown: "boom inesperado" })
  })

  it("maneja un error no-Error (string/objeto raro) sin romper", () => {
    const row = buildToolCallLogRow({ ...base, sdkSuccess: false, error: "algo raro" })
    expect(row.output).toEqual({ thrown: "algo raro" })
  })

  it("step_number null cuando el evento no lo trae", () => {
    const row = buildToolCallLogRow({ ...base, stepNumber: undefined, sdkSuccess: true, output: { ok: true } })
    expect(row.step_number).toBeNull()
  })

  it("trunca outputs muy grandes en vez de guardarlos completos", () => {
    const hugeRows = Array.from({ length: 2000 }, (_, i) => ({ DocEntry: i, ItemName: "x".repeat(20) }))
    const row = buildToolCallLogRow({ ...base, sdkSuccess: true, output: { rows: hugeRows, count: hugeRows.length } })
    expect(row.output).toMatchObject({ truncated: true })
    expect((row.output as { preview: string }).preview.length).toBeLessThanOrEqual(8000)
  })

  it("input undefined se guarda como null (no rompe JSON.stringify)", () => {
    const row = buildToolCallLogRow({ ...base, input: undefined, sdkSuccess: true, output: {} })
    expect(row.input).toBeNull()
  })
})

describe("logToolCallResult", () => {
  const sampleRow: ToolCallLogRow = {
    session_id: "s1",
    tenant_id: "tamaprint",
    tool_name: "consultar_sql",
    tool_call_id: "call_1",
    step_number: 0,
    duration_ms: 10,
    success: true,
    input: {},
    output: {},
  }

  it("inserta en la tabla chat_tool_calls con la fila tal cual", async () => {
    const insert = vi.fn().mockResolvedValue({ error: null })
    const client = { from: vi.fn().mockReturnValue({ insert }) }
    await logToolCallResult(client, sampleRow)
    expect(client.from).toHaveBeenCalledWith("chat_tool_calls")
    expect(insert).toHaveBeenCalledWith(sampleRow)
  })

  it("nunca revienta si la inserción falla (best-effort, igual que el resto de escrituras a Supabase en route.ts)", async () => {
    const client = { from: vi.fn().mockReturnValue({ insert: vi.fn().mockRejectedValue(new Error("db down")) }) }
    await expect(logToolCallResult(client, sampleRow)).resolves.toBeUndefined()
  })

  it("no se cuelga indefinidamente si el insert de Supabase nunca resuelve — misma clase de bug que motivó withSapTimeout, esta vez del lado de logging", async () => {
    vi.useFakeTimers()
    try {
      const client = { from: vi.fn().mockReturnValue({ insert: () => new Promise(() => {}) }) }
      const promise = logToolCallResult(client, sampleRow)
      let settled = false
      promise.then(() => { settled = true })
      await vi.advanceTimersByTimeAsync(4_999)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(2)
      expect(settled).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
