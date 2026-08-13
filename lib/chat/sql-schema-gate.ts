/**
 * Gate de `consultar_sql` (app/api/chat/route.ts): decide si el LLM puede
 * ejecutar SQL contra una tabla SAP sin llamar antes a `descubrir_esquema`.
 *
 * Antes de este fix, ese gate usaba `CORE_TABLES` — una lista de "tablas
 * relevantes/pre-registradas" cuyo nombre y comentario asociado en el
 * system prompt (`lib/chat/system-prompt.ts:217`, "TABLAS SAP YA
 * DESCUBIERTAS — NO necesitan descubrir_esquema") daban a entender que esas
 * tablas ya tenían su esquema (columnas reales) documentado — pero eso era
 * falso para varias de ellas (OIGN, IGN1, OQUT, QUT1, RCT2: nunca tuvieron
 * sección de columnas en el prompt). Caso real: el LLM generó SQL contra
 * `OIGN` con una columna `Remarks` inventada → SAP HANA 703 "column not
 * exist" — `OIGN`/`IGN1` estaban en `CORE_TABLES` desde el commit que
 * introdujo el mecanismo, sin nunca haber tenido su sección de columnas.
 *
 * `SCHEMA_DOCUMENTED_TABLES` es la lista correcta para este gate: SOLO las
 * tablas que sí tienen sus columnas documentadas con detalle en
 * `lib/chat/system-prompt.ts`, bajo la sección "## SCHEMA DE TABLAS CORE".
 * Si agregás una tabla acá sin documentar sus columnas reales ahí, repetís
 * el mismo bug.
 *
 * OITB y OSLP tienen sub-sección propia en esa parte del prompt, pero SIN
 * columnas — están documentadas como "NO ACCESIBLE VÍA SQL (error 702)",
 * usar OData en su lugar. Por eso NO entran acá: no tienen columnas SQL que
 * verificar, entran directo al camino de "forzar descubrir_esquema" como
 * cualquier tabla no documentada (que en la práctica solo agrega una vuelta
 * extra, ya que el prompt igual le dice al LLM que use OData para ellas).
 *
 * Nota de alcance: esto NO resuelve que `descubrir_esquema` (route.ts,
 * tool `descubrir_esquema` → `client.schema()` → gateway `sap-b1-backend`,
 * `lib/sap/metadata.ts::METADATOS_TABLAS`) sea un diccionario estático de
 * solo ~16 tablas que tampoco incluye OIGN/OWOR/WOR1/ORSC — eso es la fase 2
 * (catálogo único compartido entre `sap-b1-backend` y `sap-b1-chat`), fuera
 * de este alcance.
 */
export const SCHEMA_DOCUMENTED_TABLES = [
  "OINV", "INV1",
  "ORDR", "RDR1",
  "OPOR", "POR1",
  "OCRD",
  "OITM",
  "ORCT",
  "OWOR", "WOR1",
  "ORSC",
] as const

const SQL_KEYWORDS = new Set([
  "ORDER", "OUTER", "UNION", "OVER", "OFFSET", "ONLY", "INNER", "CROSS",
  "GROUP", "HAVING", "WHERE", "FROM", "INTO", "JOIN", "LEFT", "RIGHT", "FULL", "WITH",
])

/** Extrae identificadores con forma de tabla SAP (ej. OINV, RDR1) de una sentencia SQL. */
export function extractSapTableNames(sql: string): string[] {
  const tableMatches = sql.match(/\b(O[A-Z]{3,4}|[A-Z]{3}\d)\b/gi) ?? []
  return Array.from(
    new Set(tableMatches.map((t) => t.toUpperCase()).filter((t) => !SQL_KEYWORDS.has(t)))
  )
}

/**
 * Tablas mencionadas en `sql` que todavía no están "descubiertas" (ni
 * pre-cargadas vía `SCHEMA_DOCUMENTED_TABLES`, ni descubiertas en la sesión
 * actual vía la tool `descubrir_esquema`).
 */
export function findUndiscoveredTables(sql: string, discoveredTables: ReadonlySet<string>): string[] {
  return extractSapTableNames(sql).filter((t) => !discoveredTables.has(t))
}
