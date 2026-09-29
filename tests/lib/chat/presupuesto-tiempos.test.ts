import { describe, it, expect, vi, afterEach } from "vitest"
import { BackendError } from "@ai4u/contracts"
import * as T from "@/lib/chat/with-timeout"
import { classifySapError } from "@/lib/chat/sap-errors"

/**
 * Alineación de presupuestos chat ↔ gateway (incidente 2026-09-29, Flexo): el
 * chat cortaba a 75 004 ms con SAP_TIMEOUT mientras el backend seguía
 * trabajando, y el LLM reintentaba la misma consulta en paralelo con la primera.
 */
const backendTimeout = () =>
  new BackendError("POST", "/query", 504, JSON.stringify({ error: "SAP B1 no respondió a tiempo.", code: "SAP_TIMEOUT", uncertain: false }), "rid-29sep")

afterEach(() => { vi.useRealTimers() })

describe("timeout por tool alineado con el gateway", () => {
  it("es techo del backend (maxDuration 60 s) + margen de red: 65 s, mayor que el presupuesto SAP de 55 s", () => {
    expect(T.BACKEND_SAP_BUDGET_MS).toBe(55_000)
    expect(T.SAP_TOOL_TIMEOUT_MS).toBe(65_000)
    expect(T.SAP_TOOL_TIMEOUT_MS).toBeGreaterThan(T.BACKEND_SAP_BUDGET_MS)
    expect(T.SAP_TOOL_TIMEOUT_MS).toBeGreaterThanOrEqual(T.BACKEND_MAX_DURATION_MS + T.NETWORK_MARGIN_MS)
  })

  it("si el gateway agota su techo (504 SAP_TIMEOUT a los 60 s), el chat recibe ese error limpio — no aborta antes", async () => {
    vi.useFakeTimers()
    const backend = new Promise<never>((_, reject) => setTimeout(() => reject(backendTimeout()), T.BACKEND_MAX_DURATION_MS))
    const out = T.withSapTimeout(backend).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(T.BACKEND_MAX_DURATION_MS)
    const e = await out
    expect(e).toBeInstanceOf(BackendError)
    expect(classifySapError(e).error).toMatchObject({ code: "SAP_TIMEOUT", retryable: true })
  })
})

describe("aborto del chat ≠ SAP_TIMEOUT del gateway", () => {
  it("cuando el CHAT deja de esperar: CHAT_TIMEOUT no reintentable y el mensaje lo dice", async () => {
    vi.useFakeTimers()
    const out = T.withSapTimeout(new Promise(() => {})).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(T.SAP_TOOL_TIMEOUT_MS)
    const { error } = classifySapError(await out)
    expect(error.code).toBe("CHAT_TIMEOUT")
    expect(error.retryable).toBe(false)
    expect(error.message).toMatch(/el chat dejó de esperar/i)
    expect(error.message).toMatch(/NO reintentes/)
  })

  it("el SAP_TIMEOUT del gateway sigue siendo reintentable y dice 'SAP B1 está lento'", () => {
    const { error } = classifySapError(backendTimeout())
    expect(error).toMatchObject({ code: "SAP_TIMEOUT", retryable: true, requestId: "rid-29sep" })
    expect(error.message).toMatch(/SAP B1 está lento/)
    expect(error.message).not.toMatch(/el chat dejó de esperar/i)
  })
})

describe("presupuesto global del turno (maxDuration 300 s)", () => {
  const clock = (t0: number) => { let t = t0; return { now: () => t, advance: (ms: number) => { t += ms } } }

  it("con tiempo de sobra la llamada SAP se ejecuta", async () => {
    const c = clock(1_000_000)
    const budget = T.createTurnBudget({ maxDurationMs: 300_000, now: c.now })
    const call = vi.fn(async () => "ok")
    await expect(budget.sap(call)).resolves.toBe("ok")
    expect(call).toHaveBeenCalledTimes(1)
  })

  it("si quedan < 80 s NO se inicia el reintento: no llega nada al backend y el modelo recibe TURN_BUDGET_EXHAUSTED", async () => {
    const c = clock(1_000_000)
    const budget = T.createTurnBudget({ maxDurationMs: 300_000, now: c.now })
    c.advance(300_000 - 70_000) // quedan 70 s: ya no cabe llamada (65 s) + cierre del LLM
    const retry = vi.fn(async () => "no debería correr")
    const e = await budget.sap(retry).catch((x: unknown) => x)
    expect(retry).not.toHaveBeenCalled()
    expect(e).toBeInstanceOf(T.TurnBudgetExhaustedError)
    const { error } = classifySapError(e)
    expect(error).toMatchObject({ code: "TURN_BUDGET_EXHAUSTED", retryable: false })
    expect(error.message).toMatch(/responde YA con los datos que tienes/)
  })

  it("el umbral es timeout por tool + reserva de cierre del LLM", () => {
    expect(T.MIN_TURN_LEFT_FOR_SAP_CALL_MS).toBe(T.SAP_TOOL_TIMEOUT_MS + T.LLM_CLOSING_RESERVE_MS)
  })
})
