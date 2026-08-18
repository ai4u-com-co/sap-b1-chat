/**
 * Construye rutas REST del gateway `sap-b1-backend` para las tools
 * `obtener_documento` y `listar_registros` del chat.
 *
 * Migración 2026-08-18: antes estas funciones armaban una URL OData cruda
 * (`/{sapEntity}(id)?$expand=...`) que se mandaba tal cual al proxy
 * passthrough `GET /api/v1/{tenant}/odata?path=...`, sin ninguna
 * protección — cualquier `$expand` inválido (ej. `DocumentLines`, que en
 * SAP Service Layer es `Property(Collection(...))` del EntityType
 * `Document`, no `NavigationProperty`) llegaba a SAP tal cual y volvía un
 * 400 crudo.
 *
 * Ahora se usan las rutas REST genéricas del gateway (`handleList`/
 * `handleGet` en `sap-b1-backend/lib/sap/handler.ts`), montadas 1:1 por
 * cada clave de `ENTITY_MAP` (`GET /api/v1/{tenant}/{entityKey}` y
 * `GET /api/v1/{tenant}/{entityKey}/{id}`). Esas rutas YA resuelven del
 * lado del servidor lo que antes se parcheaba a mano acá:
 * `mergeSelectAndExpand()` (sap-b1-backend PR #124, mergeado — commit
 * `979f66a`) fusiona CUALQUIER `$expand` recibido en el `$select` final
 * antes de pedirlo a SAP, nunca arma un `$expand` real — cubre la familia
 * entera de "Property(Collection) tratada como NavigationProperty" para
 * las ~37 entidades de `ENTITY_MAP`, no solo `DocumentLines`. Por eso acá
 * ya NO hace falta ninguna traducción especial de `expand` — se pasa tal
 * cual, confiando en el backend.
 *
 * El backend también aplica su propio `entity.defaultFilter` (ej. `CardType
 * eq 'cCustomer'` para `socios/clientes`) y `entity.selectDefault` cuando el
 * caller no manda `$select` — por eso estas funciones YA NO replican esa
 * lógica (antes duplicada acá porque el proxy `/odata` no conocía
 * `ENTITY_MAP`). Evita doble aplicación y evita que este archivo dependa de
 * una copia de `ENTITY_MAP` que puede desincronizarse de la del backend.
 */

/**
 * Construye la ruta REST para obtener UN documento por su ID — usada por el
 * tool `obtener_documento` vía `lib/chat/obtener-documento.ts`.
 *
 * `entityKey` es la clave española de `ENTITY_MAP` (ej. "ventas/facturas"),
 * que coincide 1:1 con el segmento de ruta real del gateway — no hace falta
 * resolver `sapEntity`/`keyType` acá, eso lo hace el backend.
 */
export function buildDocUrl(entityKey: string, id: string, expand?: string, select?: string): string {
  const params = new URLSearchParams()
  if (select) params.set("$select", select)
  if (expand) params.set("$expand", expand)
  const qs = params.toString()
  return `/${entityKey}/${encodeURIComponent(id)}${qs ? `?${qs}` : ""}`
}

/**
 * Construye la ruta REST para listar registros de una entidad — usada por
 * el tool `listar_registros` vía `lib/chat/listar-registros.ts`.
 *
 * `top` se sanitiza client-side igual que antes (clamp 1–500, default 50)
 * porque el backend hace `parseInt(...)` sin `|| default` — un valor no
 * numérico llegaría como `$top=NaN` a la URL. El resto de parámetros
 * (`filter`, `select`, `expand`, `orderby`, `skip`) se pasan tal cual: el
 * backend ya valida/completa lo que haga falta (defaultFilter, selectDefault,
 * merge de expand en select).
 */
export function buildODataUrl(entityKey: string, query: Record<string, string>): string {
  const params = new URLSearchParams()
  const top = Math.min(parseInt(query.top ?? "50", 10) || 50, 500)
  params.set("$top", String(top))
  if (query.skip) params.set("$skip", query.skip)
  if (query.filter) params.set("$filter", query.filter)
  if (query.select) params.set("$select", query.select)
  if (query.orderby) params.set("$orderby", query.orderby)
  if (query.expand) params.set("$expand", query.expand)
  return `/${entityKey}?${params.toString()}`
}
