import { describe, it, expect } from "vitest"

/**
 * Bug real de producción (confirmado en logs, tenant flexo, docEntry 2170/2171,
 * 2026-08-13): `GET /Invoices(docEntry)?$expand=DocumentLines` → 400 SAP code
 * 201 "Cannot expand invalid navigation property 'DocumentLines' for entity
 * type 'Document'". `DocumentLines` es una `Property(Collection(...))` del
 * EntityType base `Document`, no una `NavigationProperty` — Service Layer
 * rechaza `$expand` sobre ella. Mismo patrón ya arreglado para
 * `ProductionOrderLines`/`ProductionOrdersStages` (mission-control PR #261) y
 * ya usado en producción para `Invoices` en `sap-b1-backend`
 * (`lib/capabilities/quality-certificate.ts:349,443`,
 * `lib/capabilities/production-costs.ts:112,159`), donde `$select` incluye
 * `DocumentLines` en vez de `$expand`.
 *
 * `buildDocUrl()` es la función real usada por el tool `obtener_documento`
 * del chat (app/api/chat/route.ts, importada de lib/chat/odata-url.ts) para
 * construir la URL OData contra el gateway SAP.
 */

const { buildDocUrl } = await import("@/lib/chat/odata-url")

describe("buildDocUrl — DocumentLines no se expande, se selecciona", () => {
  it("traduce expand='DocumentLines' a $select cuando ya hay un $select parcial", () => {
    const url = buildDocUrl("ventas/facturas", "2170", "DocumentLines", "DocDate,DocTotal,CardName")

    expect(url).not.toMatch(/\$expand=(?:.*,)?DocumentLines/)
    expect(url).toContain("$select=")
    expect(url).toMatch(/\$select=[^&]*\bDocumentLines\b/)
  })

  it("descarta expand='DocumentLines' sin agregar un $select restrictivo cuando no había select previo", () => {
    // Sin $select explícito, un GET normal ya trae DocumentLines incluida —
    // agregar $select=DocumentLines a solas restringiría la respuesta a
    // únicamente esa colección, perdiendo el resto de campos del documento.
    const url = buildDocUrl("ventas/facturas", "2170", "DocumentLines")

    expect(url).not.toContain("$expand=DocumentLines")
    expect(url).not.toContain("$select=DocumentLines")
  })

  it("preserva $expand para relaciones reales que no sean DocumentLines", () => {
    const url = buildDocUrl("socios/clientes", "C001", "BPAddresses")

    expect(url).toContain("$expand=BPAddresses")
  })

  it("mezcla ambos casos: mantiene el expand real y mueve solo DocumentLines a select", () => {
    const url = buildDocUrl("socios/clientes", "C001", "BPAddresses,DocumentLines", "CardName")

    expect(url).toContain("$expand=BPAddresses")
    expect(url).not.toMatch(/\$expand=[^&]*DocumentLines/)
    expect(url).toMatch(/\$select=[^&]*\bDocumentLines\b/)
  })
})
