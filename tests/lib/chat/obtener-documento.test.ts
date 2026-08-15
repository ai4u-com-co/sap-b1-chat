import { describe, it, expect, vi } from "vitest"

/**
 * Tercera recurrencia del mismo bug estructural (ver memoria del agente
 * sap-experto): el LLM confunde una columna SQL documentada en el prompt
 * (ej. `OINV.DiscSum`, `OITM.AvgStdPrice`) con el nombre de propiedad OData
 * real y la pasa como `select`/`expand` en `obtener_documento` — SAP
 * responde 400 "Property X of Document is invalid", y el gateway lo
 * sanitiza a `{error:"SAP rechazó la consulta.", code:"SAP_QUERY_ERROR"}`
 * (status 502) antes de que llegue a `sap-b1-chat` (no expone el nombre del
 * campo rechazado). Antes de este fix, `obtener_documento` fallaba la
 * respuesta completa en ese caso.
 *
 * `fetchDocumentoConFallback` es la función real usada por el tool
 * `obtener_documento` (app/api/chat/route.ts) para reintentar sin filtros.
 */

const { fetchDocumentoConFallback, SAP_QUERY_ERROR_MARKER } = await import("@/lib/chat/obtener-documento")

function gatewayError(code: string, status = 502): Error {
  return new Error(
    `Backend GET /odata?path=%2FInvoices(2170) (${status}): {"error":"SAP rechazó la consulta.","code":"${code}"}`
  )
}

describe("fetchDocumentoConFallback", () => {
  it("devuelve el documento tal cual cuando el primer intento funciona", async () => {
    const fetchOData = vi.fn().mockResolvedValue({ DocEntry: 2170, DocNum: 11713 })

    const result = await fetchDocumentoConFallback(fetchOData, "ventas/facturas", "2170", undefined, "DocDate,DiscSum")

    expect(result).toEqual({ document: { DocEntry: 2170, DocNum: 11713 } })
    expect(fetchOData).toHaveBeenCalledTimes(1)
  })

  it("reintenta sin filtros y devuelve el documento completo cuando SAP rechaza el select por SAP_QUERY_ERROR", async () => {
    const fetchOData = vi
      .fn()
      .mockRejectedValueOnce(gatewayError("SAP_QUERY_ERROR"))
      .mockResolvedValueOnce({ DocEntry: 2170, DocNum: 11713, DiscSum: 0 })

    const result = await fetchDocumentoConFallback(fetchOData, "ventas/facturas", "2170", undefined, "DocDate,DiscSum")

    expect(result.fallbackSinFiltros).toBe(true)
    expect(result.document).toEqual({ DocEntry: 2170, DocNum: 11713, DiscSum: 0 })
    expect(fetchOData).toHaveBeenCalledTimes(2)
    // El segundo intento (fallback) no debe incluir $select ni $expand.
    const fallbackUrl = fetchOData.mock.calls[1][0] as string
    expect(fallbackUrl).not.toContain("$select")
    expect(fallbackUrl).not.toContain("$expand")
  })

  it("NO reintenta si no había select/expand para empezar (el error es real, no de filtros)", async () => {
    const fetchOData = vi.fn().mockRejectedValueOnce(gatewayError("NOT_FOUND", 404))

    await expect(fetchDocumentoConFallback(fetchOData, "ventas/facturas", "999999")).rejects.toThrow()
    expect(fetchOData).toHaveBeenCalledTimes(1)
  })

  it("NO reintenta ante un error que no es SAP_QUERY_ERROR (401/404/timeout fallarían igual sin filtros)", async () => {
    const fetchOData = vi.fn().mockRejectedValueOnce(gatewayError("SAP_UNAUTHORIZED", 401))

    await expect(
      fetchDocumentoConFallback(fetchOData, "ventas/facturas", "2170", undefined, "DocDate,DiscSum")
    ).rejects.toThrow()
    expect(fetchOData).toHaveBeenCalledTimes(1)
  })

  it("propaga el error si el reintento sin filtros TAMBIÉN falla", async () => {
    const fetchOData = vi
      .fn()
      .mockRejectedValueOnce(gatewayError("SAP_QUERY_ERROR"))
      .mockRejectedValueOnce(gatewayError("SAP_TIMEOUT", 504))

    await expect(
      fetchDocumentoConFallback(fetchOData, "ventas/facturas", "2170", undefined, "DocDate,DiscSum")
    ).rejects.toThrow()
    expect(fetchOData).toHaveBeenCalledTimes(2)
  })

  it("también reintenta cuando lo rechazado fue el expand (no solo el select)", async () => {
    const fetchOData = vi
      .fn()
      .mockRejectedValueOnce(gatewayError("SAP_QUERY_ERROR"))
      .mockResolvedValueOnce({ CardCode: "C001", CardName: "Cliente Test" })

    const result = await fetchDocumentoConFallback(fetchOData, "socios/clientes", "C001", "CamposInventados")

    expect(result.fallbackSinFiltros).toBe(true)
    expect(fetchOData).toHaveBeenCalledTimes(2)
  })

  it("SAP_QUERY_ERROR_MARKER coincide con el shape real de error del gateway", () => {
    expect(gatewayError("SAP_QUERY_ERROR").message).toContain(SAP_QUERY_ERROR_MARKER)
  })
})
