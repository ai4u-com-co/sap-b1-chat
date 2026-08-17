import { ENTITY_MAP } from "@ai4u/contracts"

/**
 * Construye la URL OData para obtener un documento por su ID (usada por el
 * tool `obtener_documento` del chat).
 *
 * DocumentLines es una `Property(Collection(...))` del EntityType base
 * `Document` en SAP Service Layer, NO una `NavigationProperty`:
 * `$expand=DocumentLines` es rechazado con 400 "Cannot expand invalid
 * navigation property 'DocumentLines' for entity type 'Document'"
 * (confirmado en producción, tenant flexo, docEntry 2170/2171). Como
 * Property normal, ya viene incluida en una respuesta completa (sin
 * `$select`) — y si se usa `$select`, basta con sumarla a la lista de
 * campos. Mismo patrón que ProductionOrderLines/ProductionOrdersStages
 * (mission-control PR #261), y mismo `$select` ya usado en producción para
 * `Invoices` en `sap-b1-backend` (`lib/capabilities/quality-certificate.ts`,
 * `lib/capabilities/production-costs.ts`).
 */
export function buildDocUrl(entityKey: string, id: string, expand?: string, select?: string): string {
  const cfg = ENTITY_MAP[entityKey]
  const sapEntity = cfg?.sapEntity ?? entityKey
  const key = cfg?.keyType === "string" ? `('${encodeURIComponent(id)}')` : `(${id})`
  const expandFields = expand ? expand.split(",").map((f) => f.trim()).filter(Boolean) : []
  const realExpand = expandFields.filter((f) => f !== "DocumentLines")
  const wantsDocumentLines = expandFields.includes("DocumentLines")
  const selectFields = select ? select.split(",").map((f) => f.trim()).filter(Boolean) : []
  // Solo se agrega DocumentLines a $select si ya había un $select parcial —
  // si no había ninguno, no se agrega uno solo con DocumentLines: eso
  // restringiría la respuesta a únicamente esa colección, perdiendo el resto
  // de campos del documento que un GET sin $select trae por defecto.
  if (wantsDocumentLines && selectFields.length > 0 && !selectFields.includes("DocumentLines")) {
    selectFields.push("DocumentLines")
  }
  const parts: string[] = []
  if (realExpand.length) parts.push(`$expand=${realExpand.join(",")}`)
  if (selectFields.length) parts.push(`$select=${selectFields.join(",")}`)
  return `/${sapEntity}${key}${parts.length ? "?" + parts.join("&") : ""}`
}

/**
 * Construye la URL OData para listar registros de una entidad (usada por el
 * tool `listar_registros` del chat, vía `lib/chat/listar-registros.ts`).
 *
 * A diferencia de `buildDocUrl` (un único documento), acá NO se traduce
 * `expand='DocumentLines'` a `$select` — para una lista, degradar/reescribir
 * el `$select`/`$expand` a ciegas puede ser incorrecto según la entidad
 * (`DocumentLines` no es una property del EntityType de colección, ej.
 * `Invoices` en plural). El fallback ante un `$select`/`$expand` rechazado
 * por SAP vive en `fetchListarRegistrosConFallback` (reintento SIN esos
 * parámetros), no acá.
 */
export function buildODataUrl(entityKey: string, query: Record<string, string>): string {
  const parts: string[] = []
  const top = Math.min(parseInt(query.top ?? "50", 10) || 50, 500)
  parts.push(`$top=${top}`)
  if (query.skip) parts.push(`$skip=${query.skip}`)
  const cfg = ENTITY_MAP[entityKey]
  const filters: string[] = []
  if (cfg?.defaultFilter) filters.push(cfg.defaultFilter)
  if (query.filter) filters.push(query.filter)
  if (filters.length) parts.push(`$filter=${filters.join(" and ")}`)
  const select = query.select || cfg?.selectDefault
  if (select) parts.push(`$select=${select}`)
  if (query.orderby) parts.push(`$orderby=${query.orderby}`)
  if (query.expand) parts.push(`$expand=${query.expand}`)
  const sapEntity = cfg?.sapEntity ?? entityKey
  return `/${sapEntity}?${parts.join("&")}`
}
