/**
 * Propiedades OData (Service Layer) VERIFICADAS que el chat usa en `$select` /
 * `$filter` al consultar por OData — no nombres de columna SQL.
 *
 * Por qué existe (producción, Flexo 29-sep-2026, rid 5493f17a):
 * `buscar_socio_o_item` pidió `$select=…,LicTradNum` y `contains(LicTradNum,…)`
 * sobre /BusinessPartners y SAP respondió (-1000) "Property 'LicTradNum' of
 * 'BusinessPartner' is invalid". `LicTradNum` es la COLUMNA SQL (OCRD); la
 * propiedad OData del NIT es `FederalTaxID`. Un test contra esta lista blanca
 * falla si se vuelve a colar un nombre SQL en una consulta OData.
 *
 * Solo entra una propiedad con evidencia en código de producción de
 * sap-b1-backend (origin/master 2ea0601) que la use contra la MISMA entidad OData:
 *
 * BusinessPartners
 * - CardCode, CardName, CardType, Phone1, EmailAddress, CurrentAccountBalance:
 *   app/api/mcp/route.ts:196-197 ($select + CardType eq) y
 *   lib/sap/entities.ts:228 (selectDefault de socios/clientes);
 *   Phone1/EmailAddress/CardType también en lib/capabilities/supplier.ts:161.
 * - FederalTaxID (NIT/cédula): lib/sap/entities.ts:228-233 (selectDefault y
 *   searchFields con contains(), con la nota "en SQL es LicTradNum"),
 *   lib/capabilities/pnl.ts:608 ($select) y lib/sales-history/flexo-nit-map.ts:108
 *   (confirmado en producción contra GET /BusinessPartners).
 *
 * Items
 * - ItemCode, ItemName, AvgStdPrice, QuantityOnStock: lib/sap/entities.ts:179
 *   (selectDefault de inventario/items) y app/api/mcp/route.ts:192.
 *   (AvgStdPrice es solo OData; en SQL/OITM es AvgPrice — lib/sap/metadata.ts:9-10.)
 *
 * Si hace falta otra propiedad: verificarla primero (código del backend o
 * GET /$metadata del tenant) y agregarla acá con su fuente.
 */
export const ODATA_PROPIEDADES_VERIFICADAS = {
  BusinessPartners: ["CardCode", "CardName", "CardType", "FederalTaxID", "Phone1", "EmailAddress", "CurrentAccountBalance"],
  Items: ["ItemCode", "ItemName", "AvgStdPrice", "QuantityOnStock"],
} as const satisfies Record<string, readonly string[]>

export type EntidadVerificada = keyof typeof ODATA_PROPIEDADES_VERIFICADAS

/**
 * Propiedades referenciadas por un path OData en `$select` y `$filter`
 * (argumento de contains/startswith/endswith/substringof y operandos de
 * eq/ne/gt/ge/lt/le). Pensado para paths armados por el propio chat.
 */
export function propiedadesUsadas(path: string): { entidad: string; propiedades: string[] } {
  const entidad = path.match(/^\/([A-Za-z]+)/)?.[1] ?? ""
  const query = path.slice(path.indexOf("?") + 1)
  const props = new Set<string>()
  for (const param of query.split("&")) {
    const eq = param.indexOf("=")
    const key = param.slice(0, eq)
    const value = param.slice(eq + 1)
    if (key === "$select") {
      for (const p of value.split(",")) if (p.trim()) props.add(p.trim())
    } else if (key === "$filter") {
      // Quitar literales para no confundir texto buscado con propiedades.
      const sinLiterales = value.replace(/'(?:[^']|'')*'/g, "''")
      for (const m of sinLiterales.matchAll(/\b(?:contains|startswith|endswith)\(\s*([A-Za-z_]\w*)\s*,/g)) props.add(m[1])
      for (const m of sinLiterales.matchAll(/\bsubstringof\(\s*''\s*,\s*([A-Za-z_]\w*)\s*\)/g)) props.add(m[1])
      for (const m of sinLiterales.matchAll(/\b([A-Za-z_]\w*)\s+(?:eq|ne|gt|ge|lt|le)\s/g)) props.add(m[1])
    }
  }
  return { entidad, propiedades: [...props] }
}
