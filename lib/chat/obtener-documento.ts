import { buildDocUrl } from "@/lib/chat/odata-url"

/**
 * Fallback de resiliencia para el tool `obtener_documento` (app/api/chat/route.ts).
 *
 * Tercera recurrencia del mismo bug estructural (ver memoria del agente
 * sap-experto, `sap_b1_chat_prompt_column_fixes.md`): el LLM confunde un
 * nombre de COLUMNA SQL (documentado en el prompt para `consultar_sql`, ej.
 * `OITM.AvgStdPrice`, `OINV.DiscSum`) con el nombre de PROPIEDAD OData real
 * (`AvgPrice`, `TotalDiscount`) y lo pasa como `select`/`expand` de
 * `obtener_documento` → SAP responde 400 "Property X of Document is
 * invalid" y la respuesta completa fallaba.
 *
 * A diferencia de `consultar_sql` (que sí tiene un gate real de código,
 * `lib/chat/sql-schema-gate.ts`, porque existe un catálogo de columnas SQL
 * documentadas para contrastar), acá NO hay un catálogo de propiedades
 * OData por entidad para validar el `select`/`expand` ANTES de llamar a
 * SAP — `@ai4u/contracts` solo expone `selectDefault` (una lista corta de
 * campos default por entidad, no exhaustiva) y construir/mantener un
 * catálogo completo de propiedades OData por entidad (79+ entidades,
 * 2 versiones de Service Layer por tenant) es un esfuerzo desproporcionado
 * frente al problema real.
 *
 * Tampoco es posible reintentar quitando SOLO el campo rechazado: el
 * gateway (`sap-b1-backend`, `lib/sap/handler.ts::classifySapError`)
 * sanitiza cualquier 4xx de SAP no categorizado a un mensaje genérico
 * (`"SAP rechazó la consulta."`, code `SAP_QUERY_ERROR`) antes de
 * devolverlo — a propósito, para no filtrar detalle interno de SAP al
 * cliente — así que el nombre real del campo inválido nunca llega hasta acá.
 *
 * Por eso el fallback elegido es más simple y no depende de ningún
 * catálogo: si SAP rechaza la consulta y el pedido original incluía
 * `select`/`expand`, se reintenta UNA vez pidiendo el documento COMPLETO
 * (sin filtros) — siempre válido, porque no depende de adivinar nombres de
 * campo — y se devuelve ese documento en vez de fallar la respuesta entera.
 *
 * Migración 2026-08-18 (ver `lib/chat/odata-url.ts`): `fetchOData` ya no
 * pega contra el proxy passthrough `/odata` sino contra la ruta REST
 * genérica del gateway (`handleGet` en `sap-b1-backend/lib/sap/handler.ts`,
 * `GET /api/v1/{tenant}/{entityKey}/{id}`), que devuelve el documento SAP
 * directo (mismo shape que antes, sin wrapper) y ya resuelve del lado del
 * servidor el `$expand` inválido (`mergeSelectAndExpand`, PR #124 mergeado
 * en sap-b1-backend) — por eso `buildDocUrl` ya no traduce `DocumentLines`
 * client-side. Este fallback SIGUE haciendo falta: sigue siendo posible que
 * SAP rechace un `$select` con un nombre de campo inventado (columna SQL
 * confundida con propiedad OData), caso no relacionado con `expand`.
 */

/** Substring literal del JSON de error del gateway cuando SAP rechaza una
 *  consulta OData por un motivo no categorizado (4xx que no es 401/403/404/
 *  409/503/504) — ver `classifySapError` en `sap-b1-backend/lib/sap/handler.ts`.
 *  Es la única señal disponible para distinguir "SAP rechazó el select/expand"
 *  de un error real de negocio (documento inexistente, sesión expirada,
 *  timeout), que no tiene sentido reintentar sin filtros porque fallaría igual. */
export const SAP_QUERY_ERROR_MARKER = '"code":"SAP_QUERY_ERROR"'

export interface ObtenerDocumentoOutcome {
  document: unknown
  /** true cuando el intento original (con el select/expand pedido por el
   *  LLM) fue rechazado por SAP y se reintentó sin esos parámetros. */
  fallbackSinFiltros?: boolean
}

/**
 * Ejecuta `obtener_documento` con reintento automático sin filtros.
 *
 * `fetchOData` es una función inyectada (normalmente `client.odata`) para
 * poder testear la lógica de reintento sin depender de un servidor SAP real
 * — mismo patrón que `buildDocUrl` en `lib/chat/odata-url.ts`.
 */
export async function fetchDocumentoConFallback(
  fetchOData: (odataPath: string) => Promise<unknown>,
  entityKey: string,
  id: string,
  expand?: string,
  select?: string
): Promise<ObtenerDocumentoOutcome> {
  const primaryUrl = buildDocUrl(entityKey, id, expand, select)
  try {
    return { document: await fetchOData(primaryUrl) }
  } catch (err) {
    const hadFilters = Boolean(select) || Boolean(expand)
    const msg = err instanceof Error ? err.message : String(err)
    // Nada que "aflojar" (no había select/expand), o el error no es el
    // catch-all de consulta rechazada (401/404/timeout fallarían igual sin
    // filtros) — no reintentar, dejar que el caller clasifique el error.
    if (!hadFilters || !msg.includes(SAP_QUERY_ERROR_MARKER)) throw err
    const fallbackUrl = buildDocUrl(entityKey, id)
    const document = await fetchOData(fallbackUrl)
    return { document, fallbackSinFiltros: true }
  }
}
