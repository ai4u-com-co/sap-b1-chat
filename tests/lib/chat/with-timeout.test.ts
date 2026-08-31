import { describe, it, expect } from "vitest"
import { withSapTimeout } from "@/lib/chat/with-timeout"

/**
 * Regresión del incidente 2026-08-31 (tenant flexoimpresos, rid=398894ad):
 * `consultar_sql` se quedó colgado en "Ejecutando consulta SQL en SAP…"
 * (6 bloques de razonamiento + 9 pasos, spinner infinito) porque
 * `BackendClient.get/post/patch` (@ai4u/contracts) hace `fetch()` sin
 * `AbortSignal` ni timeout propio, y el único límite de tiempo de toda la
 * función serverless es `maxDuration = 300` en app/api/chat/route.ts —
 * un kill duro de Vercel que mata la función a mitad del tool call sin
 * pasar por ningún `onError` de la AI SDK, dejando el stream (y el
 * cliente) sin ningún evento de cierre.
 *
 * `withSapTimeout` es el fix: envuelve cualquier `await client.*` con un
 * `Promise.race` contra un timeout mucho más corto que los 300s duros, y
 * el mensaje de error resultante contiene la palabra "timeout" a propósito
 * — `classifySapError` (route.ts) ya la reconoce y la clasifica como
 * `{ code: "SAP_TIMEOUT", retryable: true }` sin necesitar ningún cambio
 * en los `catch` existentes de las ~49 tools que llaman a SAP.
 */
describe("withSapTimeout", () => {
  it("resuelve con el valor real cuando la promesa gana la carrera", async () => {
    const result = await withSapTimeout(Promise.resolve({ rows: [1, 2, 3] }), 1000)
    expect(result).toEqual({ rows: [1, 2, 3] })
  })

  it("propaga el error real (no de timeout) cuando la promesa rechaza antes del límite", async () => {
    const boom = new Error("Backend GET /Items (404): not found")
    await expect(withSapTimeout(Promise.reject(boom), 1000)).rejects.toBe(boom)
  })

  it("rechaza con un mensaje que contiene 'timeout' cuando la promesa nunca resuelve (fetch colgado, el bug real)", async () => {
    const neverResolves = new Promise(() => {}) // simula el fetch sin AbortSignal colgado indefinidamente
    await expect(withSapTimeout(neverResolves, 15)).rejects.toThrow(/timeout/i)
  })

  it("el mensaje de timeout incluye el límite usado, para que quede en el log/tool-result", async () => {
    const neverResolves = new Promise(() => {})
    await expect(withSapTimeout(neverResolves, 15)).rejects.toThrow(/15ms/)
  })

  it("usa el default de 75000ms cuando no se pasa 'ms' explícito (no bloquea el test, solo inspecciona que no rechace antes)", async () => {
    // No esperamos los 75s reales: solo confirmamos que con una promesa que
    // resuelve rápido, el default no la corta.
    const result = await withSapTimeout(Promise.resolve("ok"))
    expect(result).toBe("ok")
  })
})
