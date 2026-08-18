import { describe, it, expect } from "vitest"

/**
 * Migración 2026-08-18: `buildDocUrl`/`buildODataUrl` (usadas por
 * `obtener_documento`/`listar_registros`, ver `lib/chat/odata-url.ts`) ya no
 * arman una URL OData cruda para el proxy passthrough `/odata`, sino una
 * ruta REST del gateway (`GET /api/v1/{tenant}/{entityKey}` y
 * `GET /api/v1/{tenant}/{entityKey}/{id}`), que resuelve del lado del
 * servidor (`handleList`/`handleGet` en `sap-b1-backend/lib/sap/handler.ts`,
 * `mergeSelectAndExpand`, PR sap-b1-backend#124 mergeado) el bug real de
 * producción (tenant flexo, docEntry 2170/2171, 2026-08-13):
 * `GET /Invoices(docEntry)?$expand=DocumentLines` → 400 "Cannot expand
 * invalid navigation property 'DocumentLines' for entity type 'Document'"
 * (`DocumentLines` es `Property(Collection(...))`, no `NavigationProperty`).
 *
 * Por eso estas funciones YA NO traducen `expand` client-side (a diferencia
 * de la versión anterior de este archivo) — confían en que el backend
 * fusiona cualquier `$expand` en `$select` de forma segura y genérica para
 * las ~37 entidades de `ENTITY_MAP`, no solo `DocumentLines`.
 */

const { buildDocUrl, buildODataUrl } = await import("@/lib/chat/odata-url")

describe("buildDocUrl — ruta REST del gateway, sin traducción de expand", () => {
  it("arma la ruta REST literal /{entityKey}/{id} sin query si no hay select/expand", () => {
    const url = buildDocUrl("ventas/facturas", "2170")
    expect(url).toBe("/ventas/facturas/2170")
  })

  it("pasa expand='DocumentLines' TAL CUAL como $expand, sin traducirlo a $select (lo resuelve el backend)", () => {
    const url = buildDocUrl("ventas/facturas", "2170", "DocumentLines")
    expect(url).toBe("/ventas/facturas/2170?%24expand=DocumentLines")
  })

  it("incluye select cuando se pide, codificado como query param real ($ codificado, no literal)", () => {
    const url = buildDocUrl("ventas/facturas", "2170", undefined, "DocDate,DocTotal,CardName")
    const [, qs] = url.split("?")
    const params = new URLSearchParams(qs)
    expect(params.get("$select")).toBe("DocDate,DocTotal,CardName")
    expect(params.has("$expand")).toBe(false)
  })

  it("preserva select y expand simultáneos, cada uno en su propio parámetro", () => {
    const url = buildDocUrl("socios/clientes", "C001", "BPAddresses", "CardName")
    const params = new URLSearchParams(url.split("?")[1])
    expect(params.get("$expand")).toBe("BPAddresses")
    expect(params.get("$select")).toBe("CardName")
  })

  it("codifica el id (path segment) por si trae caracteres especiales", () => {
    const url = buildDocUrl("socios/clientes", "C 001/A")
    expect(url).toBe(`/socios/clientes/${encodeURIComponent("C 001/A")}`)
  })
})

describe("buildODataUrl — ruta REST del gateway para listas", () => {
  it("siempre incluye $top con default 50 cuando no se especifica", () => {
    const url = buildODataUrl("ventas/facturas", {})
    const params = new URLSearchParams(url.split("?")[1])
    expect(params.get("$top")).toBe("50")
  })

  it("clampea $top a 500 como máximo", () => {
    const url = buildODataUrl("ventas/facturas", { top: "999999" })
    const params = new URLSearchParams(url.split("?")[1])
    expect(params.get("$top")).toBe("500")
  })

  it("usa 50 si $top no es un número válido (evita mandar $top=NaN al backend)", () => {
    const url = buildODataUrl("ventas/facturas", { top: "no-es-un-numero" })
    const params = new URLSearchParams(url.split("?")[1])
    expect(params.get("$top")).toBe("50")
  })

  it("NO aplica defaultFilter ni selectDefault client-side — el backend ya los conoce por entityKey", () => {
    const url = buildODataUrl("socios/clientes", {})
    const params = new URLSearchParams(url.split("?")[1])
    expect(params.has("$filter")).toBe(false)
    expect(params.has("$select")).toBe(false)
  })

  it("pasa filter/select/expand/orderby/skip tal cual, correctamente codificados", () => {
    const url = buildODataUrl("ventas/facturas", {
      filter: "DocDate ge '2026-05-01'",
      select: "DocDate,DocTotal",
      expand: "DocumentLines",
      orderby: "DocDate desc",
      skip: "10",
    })
    const params = new URLSearchParams(url.split("?")[1])
    expect(params.get("$filter")).toBe("DocDate ge '2026-05-01'")
    expect(params.get("$select")).toBe("DocDate,DocTotal")
    expect(params.get("$expand")).toBe("DocumentLines")
    expect(params.get("$orderby")).toBe("DocDate desc")
    expect(params.get("$skip")).toBe("10")
  })

  it("el path base es literalmente /{entityKey}, sin resolver sapEntity", () => {
    const url = buildODataUrl("compras/ordenes", {})
    expect(url.startsWith("/compras/ordenes?")).toBe(true)
  })
})
