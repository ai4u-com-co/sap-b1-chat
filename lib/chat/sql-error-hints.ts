import { SAP_TABLE_SCHEMAS } from "@ai4u/contracts"

/**
 * Error 703 de SAP ("Column 'X' from table 'T' not exist"): el LLM usó una
 * columna que no existe. Antes caía en el bucket genérico SAP_ERROR con el JSON
 * crudo; en `platform_logs` (30 días) hubo ~56 casos, entre ellos columnas
 * inventadas como OWOR.Remarks / OWOR.DocDate, WOR1.LineType y OCRD.FederalTaxID.
 *
 * Este módulo lo convierte en un error accionable: nombra tabla y columna, da el
 * nombre SQL correcto cuando está VERIFICADO, sugiere columnas documentadas
 * parecidas y le dice al LLM qué hacer en vez de adivinar otra variante.
 */

export type SqlHintError = { code: string; message: string; retryable: boolean }
type Schemas = Record<string, { camposComunes: Array<{ campo: string }> }>

export interface ColumnNotFound {
  column: string
  table: string
}

// El mensaje llega dentro de un JSON anidado, así que las comillas pueden venir
// escapadas: `Column '\"Remarks\"' from table 'OWOR' not exist.` o sin comillas
// internas: `Column 'DocDate' from table 'OWOR' not exist.`
const COLUMN_NOT_FOUND_RE =
  /Column\s+'[\\"]*([A-Za-z_][\w$#]*)[\\"]*'\s+from\s+table\s+'[\\"]*([A-Za-z_@][\w$#@]*)[\\"]*'\s+not\s+exist/i

export function parseColumnNotFound(message: string): ColumnNotFound | null {
  const m = message.match(COLUMN_NOT_FOUND_RE)
  return m ? { column: m[1], table: m[2].toUpperCase() } : null
}

/**
 * Nombres SQL correctos de columnas que el LLM (u otro código) suele confundir
 * con el nombre de la propiedad OData o con un nombre inventado. SOLO entran
 * equivalencias verificadas en código de producción de sap-b1-backend:
 * - OCRD.LicTradNum: lib/sap/entities.ts ("HANA SQLQueries la rechaza bajo ese
 *   nombre [FederalTaxID], ahí es LicTradNum") y capabilities/invoiceloader.ts.
 * - WOR1.ItemType: CLAUDE.md del backend (290=recurso, 4=materia prima, -18=texto).
 * - CANCELED: query-catalog.ts / compatibleQueries.ts (cabeceras OINV/ORDR).
 * - OWOR.StartDate / CloseDate: production-order-format.ts, production-variance.ts.
 * Si una equivalencia no está verificada, NO se agrega: mejor no sugerir nada
 * que repetir el error de adivinar.
 */
const VERIFIED_ALIASES: Array<{ table?: string; bad: string; good: string; note: string }> = [
  { table: "OCRD", bad: "FederalTaxID", good: "LicTradNum", note: "NIT / ID tributario del socio" },
  { table: "WOR1", bad: "LineType", good: "ItemType", note: "290 = recurso/máquina, 4 = materia prima, -18 = línea de texto" },
  { table: "OWOR", bad: "DocDate", good: "StartDate o CloseDate", note: "OWOR no tiene DocDate; esas dos fechas están confirmadas en producción (formato YYYYMMDD)" },
  { bad: "Cancelled", good: "CANCELED", note: "columna de cancelado en cabeceras de documentos (verificada en OINV/ORDR), valores 'Y'/'N'" },
]

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array<number>(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) dp[0][j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
    }
  }
  return dp[a.length][b.length]
}

export function suggestColumns(documented: string[], badColumn: string, max = 3): string[] {
  const bad = badColumn.toLowerCase()
  const threshold = Math.max(2, Math.floor(bad.length / 3))
  return documented
    .map((c) => ({ c, d: levenshtein(bad, c.toLowerCase()) }))
    .filter((x) => x.d <= threshold)
    .sort((x, y) => x.d - y.d)
    .slice(0, max)
    .map((x) => x.c)
}

/**
 * Devuelve el error accionable si `message` es un 703 de "columna no existe";
 * `null` si no lo es (el caller sigue con el resto de su clasificación).
 * `schemas` es inyectable para tests; por defecto, el catálogo compartido.
 */
export function classifyColumnNotFound(
  message: string,
  schemas: Schemas = SAP_TABLE_SCHEMAS as Schemas,
): SqlHintError | null {
  const parsed = parseColumnNotFound(message)
  if (!parsed) return null
  const { column, table } = parsed

  const documented = (schemas[table]?.camposComunes ?? []).map((c) => c.campo)
  const parts: string[] = [
    `La columna "${column}" NO existe en la tabla ${table} (error 703 de SAP). No la inventes ni pruebes variantes al azar.`,
  ]

  const alias = VERIFIED_ALIASES.find(
    (a) => a.bad.toLowerCase() === column.toLowerCase() && (!a.table || a.table === table),
  )
  if (alias) parts.push(`En SQL el nombre correcto es "${alias.good}" (${alias.note}).`)

  if (column.toUpperCase().startsWith("U_")) {
    parts.push(`"${column}" parece un campo de usuario (UDF) que no existe en la empresa actual: los UDF cambian por tenant.`)
  }

  const casing = documented.find((c) => c.toLowerCase() === column.toLowerCase())
  if (casing) {
    parts.push(`HANA distingue mayúsculas: el nombre documentado es "${casing}".`)
  } else {
    const near = suggestColumns(documented, column)
    if (near.length > 0) parts.push(`Columnas documentadas parecidas: ${near.join(", ")}.`)
  }

  if (documented.length > 0) {
    parts.push(`Columnas SQL documentadas de ${table}: ${documented.slice(0, 15).join(", ")}${documented.length > 15 ? ", …" : ""}.`)
  }

  parts.push(
    `Siguiente paso: llama descubrir_esquema('${table}') y usa solo las columnas SQL de camposComunes. ` +
      `Si el dato que necesitas no está documentado, pídelo por OData (listar_registros / obtener_documento) o dile al usuario que no puedes obtenerlo por SQL.`,
  )

  return { code: "SAP_COLUMN_NOT_FOUND", message: parts.join(" "), retryable: true }
}
