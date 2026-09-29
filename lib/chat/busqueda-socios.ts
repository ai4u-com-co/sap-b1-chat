/**
 * Construcción del `$filter` OData de `buscar_socio_o_item` (app/api/chat/route.ts).
 *
 * Por qué existe (evidencia de producción, Flexo 29-sep-2026): "¿Cuánto nos ha
 * facturado Mariano Garcia?" → la tool buscó contains(CardName,'Mariano Garcia') y
 * devolvió 0, pero el socio existe como "GARCIA POSADA MARIANO" (CardCode P8026979).
 * Dos causas: (1) el texto se buscaba como UNA subcadena, así que el orden de las
 * palabras rompía la búsqueda; (2) `contains` en SAP B1 sobre HANA se traduce a un
 * LIKE que distingue mayúsculas, y los maestros están casi siempre en MAYÚSCULAS.
 *
 * Qué hace:
 * - Texto con palabras → un `contains` por palabra, unidos con AND (el orden deja de
 *   importar). Cada palabra se busca en varias variantes de mayúsculas
 *   (original / MAYÚSCULAS / minúsculas / Título, y sin tildes) unidas con OR.
 *   NO se usa `tolower()`: no está entre las funciones de filtro documentadas de
 *   Service Layer (la skill sap-b1-service-layer y el propio gateway solo usan
 *   contains/startswith) y no se pudo verificar en vivo contra los dos tenants; las
 *   variantes funcionan con cualquier collation de HANA sin depender de eso.
 * - Texto numérico (NIT/cédula, con puntos, espacios o dígito de verificación) →
 *   busca en FederalTaxID (NIT) y CardCode (en Flexo los proveedores persona natural
 *   son "P" + cédula, p.ej. P8026979).
 * - OData, no SQL: el NIT es la propiedad `FederalTaxID` de BusinessPartners. Su
 *   columna SQL (OCRD) se llama `LicTradNum`, y usarla acá hizo fallar la búsqueda
 *   en producción (Flexo 29-sep-2026, SAP -1000 "Property 'LicTradNum' of
 *   'BusinessPartner' is invalid"). Toda propiedad de $select/$filter debe estar en
 *   ODATA_PROPIEDADES_VERIFICADAS (lib/chat/odata-propiedades.ts); hay test.
 * - Toda variante se escapa ('' por ') DESPUÉS de generarla.
 *
 * Multitenant: no nombra tenants; el gateway resuelve la empresa por la API key.
 */

export type TipoBusqueda = "cliente" | "proveedor" | "socio" | "item"

const MAX_TOKENS = 4
const MAX_TEXTO = 100
/** Por debajo de MAX_SAP_PATH_LENGTH (1900) del gateway (lib/sap/client.ts), con margen. */
const MAX_PATH = 1700
// Palabras que casi nunca discriminan en un nombre y que multiplican el filtro.
const STOPWORDS = new Set(["de", "del", "la", "las", "los", "el", "y", "e", "sa", "sas", "s.a.s", "s.a.s.", "s.a", "s.a.", "ltda", "ltda."])

const escapeOData = (s: string) => s.replace(/'/g, "''")

export function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "")
}

function titleCase(s: string): string {
  const lower = s.toLocaleLowerCase("es")
  return lower.charAt(0).toLocaleUpperCase("es") + lower.slice(1)
}

/** Variantes de mayúsculas/tildes de una palabra, sin duplicados, en orden estable. */
export function caseVariants(token: string): string[] {
  const base = [token, token.toLocaleUpperCase("es"), token.toLocaleLowerCase("es"), titleCase(token)]
  const out: string[] = []
  for (const v of [...base, ...base.map(stripAccents)]) {
    if (!out.includes(v)) out.push(v)
  }
  return out
}

export function sanitizeTexto(texto: string): string {
  return texto.replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, MAX_TEXTO)
}

/**
 * Si el texto es un documento (NIT/cédula) devuelve solo los dígitos del número
 * principal (sin puntos, espacios ni dígito de verificación). Si no, null.
 * "8026979" → "8026979"; "900.123.456-7" → "900123456"; "P8026979" → null.
 */
export function documentoNumerico(texto: string): string | null {
  const t = texto.trim()
  if (!/^[\d.\s-]+$/.test(t)) return null
  const sinDv = /^[\d.\s]+-\s*\d$/.test(t) ? t.slice(0, t.lastIndexOf("-")) : t
  const digits = sinDv.replace(/\D/g, "")
  return digits.length >= 3 ? digits : null
}

/** Palabras de búsqueda: sin stopwords (salvo que sea lo único), las más largas primero, máx. 4. */
export function tokenize(texto: string): string[] {
  const raw = texto.split(/[\s,;]+/).map((t) => t.trim()).filter((t) => t.length >= 2)
  const utiles = raw.filter((t) => !STOPWORDS.has(t.toLocaleLowerCase("es")))
  const elegidas = utiles.length ? utiles : raw
  const unicas = [...new Map(elegidas.map((t) => [t.toLocaleLowerCase("es"), t])).values()]
  return unicas.sort((a, b) => b.length - a.length).slice(0, MAX_TOKENS)
}

function tokenClause(token: string, nameField: string, codeField: string): string {
  const parts = caseVariants(token).map((v) => `contains(${nameField},'${escapeOData(v)}')`)
  const codeVariants = [...new Set([token.toLocaleUpperCase("es"), token])]
  for (const v of codeVariants) parts.push(`contains(${codeField},'${escapeOData(v)}')`)
  return `(${parts.join(" or ")})`
}

export interface BusquedaPlan {
  path: string
  /** Descripción corta de cómo se buscó (para que el modelo la explique si hay 0 resultados). */
  criterio: string
}

/** Filtro de texto (sin tipo) sobre nombre/código; exportado para tests. */
export function buildTextFilter(texto: string, nameField: string, codeField: string, tokens = tokenize(texto)): string {
  if (!tokens.length) return tokenClause(texto, nameField, codeField)
  return tokens.map((t) => tokenClause(t, nameField, codeField)).join(" and ")
}

/**
 * Si el path se pasa del largo de URL del gateway, descarta las palabras más
 * cortas (tokenize ya las ordenó de más larga a más corta) hasta que quepa.
 */
function fitTokens(texto: string, build: (tokens: string[]) => string): { path: string; tokens: string[] } {
  let tokens = tokenize(texto)
  let path = build(tokens)
  while (path.length > MAX_PATH && tokens.length > 1) {
    tokens = tokens.slice(0, -1)
    path = build(tokens)
  }
  return { path, tokens }
}

/** Arma el path OData de la búsqueda. `top` ya viene acotado por el caller. */
export function buildBusquedaPath(tipo: TipoBusqueda, textoCrudo: string, top: number): BusquedaPlan {
  const texto = sanitizeTexto(textoCrudo)

  if (tipo === "item") {
    const select = "$select=ItemCode,ItemName,AvgStdPrice,QuantityOnStock"
    const { path, tokens } = fitTokens(texto, (tk) =>
      `/Items?${select}&$top=${top}&$filter=${buildTextFilter(texto, "ItemName", "ItemCode", tk)}`,
    )
    return { path, criterio: `ItemName/ItemCode contienen todas las palabras [${tokens.join(", ") || texto}] (sin distinguir mayúsculas ni orden)` }
  }

  const select = "$select=CardCode,CardName,CardType,FederalTaxID,Phone1,EmailAddress,CurrentAccountBalance"
  const tipoFilter =
    tipo === "cliente" ? "CardType eq 'cCustomer'" : tipo === "proveedor" ? "CardType eq 'cSupplier'" : null
  const withTipo = (f: string) => (tipoFilter ? `(${tipoFilter}) and (${f})` : f)

  const doc = documentoNumerico(texto)
  if (doc) {
    const f = `contains(FederalTaxID,'${doc}') or contains(CardCode,'${doc}')`
    return {
      path: `/BusinessPartners?${select}&$top=${top}&$filter=${withTipo(f)}`,
      criterio: `NIT/cédula (campo FederalTaxID) o CardCode contienen ${doc}`,
    }
  }

  const { path, tokens } = fitTokens(texto, (tk) =>
    `/BusinessPartners?${select}&$top=${top}&$filter=${withTipo(buildTextFilter(texto, "CardName", "CardCode", tk))}`,
  )
  return {
    path,
    criterio: `CardName/CardCode contienen todas las palabras [${tokens.join(", ") || texto}] en cualquier orden, sin distinguir mayúsculas`,
  }
}
