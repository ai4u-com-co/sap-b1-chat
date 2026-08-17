import { buildODataUrl } from "@/lib/chat/odata-url"
import { SAP_QUERY_ERROR_MARKER } from "@/lib/chat/obtener-documento"

/**
 * Fallback de resiliencia para el tool `listar_registros` (app/api/chat/route.ts).
 *
 * Mismo bug estructural que `obtener_documento`
 * (ver `lib/chat/obtener-documento.ts` y memoria del agente sap-experto,
 * `documentlines_expand_not_navprop.md` / `sap_b1_chat_prompt_column_fixes.md`):
 * el LLM arma `select`/`expand`/`filter` libres para `buildODataUrl()` y a
 * veces pasa una propiedad OData inválida (columna SQL confundida, o
 * `expand=DocumentLines` que Service Layer rechaza por no ser
 * NavigationProperty) — SAP responde 400 y el gateway lo sanitiza a
 * `{code:"SAP_QUERY_ERROR"}` sin exponer el nombre del campo (ver
 * `obtener-documento.ts` para el detalle de por qué no se puede reintentar
 * quitando SOLO el campo rechazado).
 *
 * DIFERENCIA CLAVE con `obtener_documento`: ahí, reintentar sin filtros
 * sigue devolviendo el MISMO documento (más campos, no cambia qué se pidió).
 * Acá se pide una LISTA — degradar el `$filter` cambiaría el conjunto de
 * filas devuelto (ej. "facturas de mayo" se convertiría silenciosamente en
 * "todas las facturas"), lo cual ya no sería la respuesta a lo que preguntó
 * el usuario. Por eso el fallback es de dos escalones, y el segundo NUNCA
 * toca el `$filter`:
 *
 * 1. Si SAP rechaza la consulta y el pedido traía `select`/`expand`: se
 *    reintenta quitando SOLO esos dos parámetros — es seguro porque preserva
 *    el `$filter` (mismo conjunto de filas) y de paso resuelve la
 *    traducción `expand=DocumentLines`→sin filtros de campo, porque
 *    simplemente no se piden campos específicos en el reintento (queda a
 *    criterio de `buildODataUrl`, que puede volver a aplicar el
 *    `selectDefault` curado de la entidad si existe — nunca un campo
 *    inventado por el LLM). Si funciona, se marca `fallbackSinFiltrosDeCampos`
 *    para que el caller avise que se ignoraron los filtros de campo pedidos.
 * 2. Si el error persiste incluso sin `select`/`expand`, o si el pedido
 *    original no tenía `select`/`expand` para aflojar (el problema está en
 *    el `$filter` mismo, no en los campos), NO se degrada el `$filter` en
 *    silencio: se propaga el error tal cual para que el LLM reconsidere
 *    (por ejemplo, llamando `descubrir_esquema` antes de reintentar con un
 *    filtro distinto).
 */

export interface ListarRegistrosOutcome {
  rows: unknown[]
  count: number
  /** true cuando el intento original (con el select/expand pedido por el
   *  LLM) fue rechazado por SAP y se reintentó sin esos dos parámetros,
   *  preservando filter/top/skip/orderby intactos. */
  fallbackSinFiltrosDeCampos?: boolean
}

/**
 * Ejecuta `listar_registros` con reintento automático sin `select`/`expand`.
 *
 * `fetchOData` es una función inyectada (normalmente `client.odata`) para
 * poder testear la lógica de reintento sin depender de un servidor SAP real
 * — mismo patrón que `fetchDocumentoConFallback` en `lib/chat/obtener-documento.ts`.
 */
export async function fetchListarRegistrosConFallback(
  fetchOData: (odataPath: string) => Promise<{ value?: unknown[] }>,
  entityKey: string,
  query: Record<string, string>
): Promise<ListarRegistrosOutcome> {
  const primaryUrl = buildODataUrl(entityKey, query)
  try {
    const data = await fetchOData(primaryUrl)
    const rows = data.value ?? []
    return { rows, count: rows.length }
  } catch (err) {
    const hadFieldFilters = Boolean(query.select) || Boolean(query.expand)
    const msg = err instanceof Error ? err.message : String(err)
    // Nada que aflojar (no había select/expand — el problema es el filter
    // mismo), o el error no es el catch-all de consulta rechazada (401/404/
    // timeout fallarían igual sin select/expand) — no reintentar, y sobre
    // todo NUNCA degradar el $filter para "adivinar" un resultado.
    if (!hadFieldFilters || !msg.includes(SAP_QUERY_ERROR_MARKER)) throw err
    const rest = { ...query }
    delete rest.select
    delete rest.expand
    const fallbackUrl = buildODataUrl(entityKey, rest)
    // Si esto también falla, se propaga tal cual — no hay un tercer intento
    // ni degradación del filter.
    const data = await fetchOData(fallbackUrl)
    const rows = data.value ?? []
    return { rows, count: rows.length, fallbackSinFiltrosDeCampos: true }
  }
}
