import { describe, it, expect, vi } from "vitest"

/**
 * Mismo bug estructural que `obtener_documento` (ver
 * `tests/lib/chat/obtener-documento.test.ts` y memoria del agente
 * sap-experto): el LLM arma `select`/`expand` libres para `listar_registros`
 * y a veces pasa una propiedad OData inválida — SAP responde 400, el gateway
 * lo sanitiza a `{error:"SAP rechazó la consulta.", code:"SAP_QUERY_ERROR"}`
 * (status 502) sin exponer el campo rechazado.
 *
 * Diferencia clave con `obtener_documento`: acá el fallback NUNCA toca el
 * `$filter` — solo se reintenta quitando `select`/`expand`. Si eso no
 * alcanza, o no había select/expand para aflojar, se propaga el error tal
 * cual (no se degrada el filter para "adivinar" una lista distinta).
 *
 * `fetchListarRegistrosConFallback` es la función real usada por el tool
 * `listar_registros` (app/api/chat/route.ts).
 */

const { fetchListarRegistrosConFallback } = await import("@/lib/chat/listar-registros")

function gatewayError(code: string, status = 502): Error {
  return new Error(
    `Backend GET /odata?path=%2FInvoices (${status}): {"error":"SAP rechazó la consulta.","code":"${code}"}`
  )
}

describe("fetchListarRegistrosConFallback", () => {
  it("devuelve las filas tal cual cuando el primer intento funciona", async () => {
    const fetchOData = vi.fn().mockResolvedValue({ value: [{ DocEntry: 1 }, { DocEntry: 2 }] })

    const result = await fetchListarRegistrosConFallback(fetchOData, "ventas/facturas", {
      filter: "DocDate ge '2026-05-01'",
      select: "DocDate,DiscSum",
    })

    expect(result).toEqual({ rows: [{ DocEntry: 1 }, { DocEntry: 2 }], count: 2 })
    expect(fetchOData).toHaveBeenCalledTimes(1)
  })

  it("fallback nivel 1: reintenta sin select/expand y preserva el filter cuando SAP rechaza el select", async () => {
    const fetchOData = vi
      .fn()
      .mockRejectedValueOnce(gatewayError("SAP_QUERY_ERROR"))
      .mockResolvedValueOnce({ value: [{ DocEntry: 1 }, { DocEntry: 2 }, { DocEntry: 3 }] })

    const result = await fetchListarRegistrosConFallback(fetchOData, "ventas/facturas", {
      filter: "DocDate ge '2026-05-01'",
      select: "DocDate,DiscSum",
    })

    expect(result.fallbackSinFiltrosDeCampos).toBe(true)
    expect(result.rows).toHaveLength(3)
    expect(result.count).toBe(3)
    expect(fetchOData).toHaveBeenCalledTimes(2)
    // El segundo intento (fallback) preserva el $filter original...
    const fallbackUrl = fetchOData.mock.calls[1][0] as string
    expect(fallbackUrl).toContain("DocDate ge")
    // ...pero no manda el select/expand original con el campo inválido.
    expect(fallbackUrl).not.toContain("DiscSum")
  })

  it("fallback nivel 1 también aplica cuando lo rechazado fue el expand (ej. DocumentLines)", async () => {
    const fetchOData = vi
      .fn()
      .mockRejectedValueOnce(gatewayError("SAP_QUERY_ERROR"))
      .mockResolvedValueOnce({ value: [{ DocEntry: 1 }] })

    const result = await fetchListarRegistrosConFallback(fetchOData, "ventas/facturas", {
      filter: "DocDate ge '2026-05-01'",
      expand: "DocumentLines",
    })

    expect(result.fallbackSinFiltrosDeCampos).toBe(true)
    expect(fetchOData).toHaveBeenCalledTimes(2)
    const fallbackUrl = fetchOData.mock.calls[1][0] as string
    expect(fallbackUrl).not.toContain("$expand")
    expect(fallbackUrl).toContain("DocDate ge")
  })

  it("SIN select/expand para aflojar: propaga el error y NO degrada el filter (el problema es el filter mismo)", async () => {
    const fetchOData = vi.fn().mockRejectedValueOnce(gatewayError("SAP_QUERY_ERROR"))

    await expect(
      fetchListarRegistrosConFallback(fetchOData, "ventas/facturas", {
        filter: "CampoInventado eq 'X'",
      })
    ).rejects.toThrow()
    // No hay nada que aflojar (no había select/expand) → un solo intento,
    // nunca se reintenta con el filter cambiado o quitado.
    expect(fetchOData).toHaveBeenCalledTimes(1)
  })

  it("CON select/expand: si el fallback nivel 1 TAMBIÉN falla, propaga el error tras el segundo intento (sin degradar el filter)", async () => {
    const fetchOData = vi
      .fn()
      .mockRejectedValueOnce(gatewayError("SAP_QUERY_ERROR"))
      .mockRejectedValueOnce(gatewayError("SAP_QUERY_ERROR"))

    await expect(
      fetchListarRegistrosConFallback(fetchOData, "ventas/facturas", {
        filter: "DocDate ge '2026-05-01'",
        select: "DocDate,DiscSum",
      })
    ).rejects.toThrow()
    // Exactamente 2 intentos: primario + fallback sin select/expand. Ningún
    // tercer intento que toque el $filter.
    expect(fetchOData).toHaveBeenCalledTimes(2)
  })

  it("NO reintenta ante un error que no es SAP_QUERY_ERROR (401/404/timeout fallarían igual sin select/expand)", async () => {
    const fetchOData = vi.fn().mockRejectedValueOnce(gatewayError("SAP_AUTH", 401))

    await expect(
      fetchListarRegistrosConFallback(fetchOData, "ventas/facturas", {
        filter: "DocDate ge '2026-05-01'",
        select: "DocDate,DiscSum",
      })
    ).rejects.toThrow()
    expect(fetchOData).toHaveBeenCalledTimes(1)
  })
})
