import { describe, it, expect } from "vitest"
import { SCHEMA_DOCUMENTED_TABLES, extractSapTableNames, findUndiscoveredTables } from "@/lib/chat/sql-schema-gate"

/**
 * Regresión del gate de `consultar_sql` (app/api/chat/route.ts): antes de
 * este fix, el gate se inicializaba con `CORE_TABLES` — una lista de
 * "tablas relevantes" que incluía `OIGN`/`IGN1` sin que esas tablas
 * tuvieran nunca sus columnas documentadas en `lib/chat/system-prompt.ts`.
 * Eso dejaba pasar SQL contra `OIGN` sin forzar `descubrir_esquema`
 * primero, y el LLM inventó una columna (`Remarks`) que no existe →
 * SAP HANA 703 "column not exist" en producción.
 *
 * Estos tests prueban el comportamiento correcto:
 * (a) una tabla SÍ documentada (ej. OITM) pasa el gate sin
 *     `descubrir_esquema` previo.
 * (b) una tabla NO documentada (ej. OIGN) es bloqueada por el gate hasta
 *     que se llame `descubrir_esquema` (es decir, hasta que se agregue a
 *     `discoveredTables` en tiempo de ejecución).
 */
describe("sql-schema-gate", () => {
  it("SCHEMA_DOCUMENTED_TABLES no incluye OIGN/IGN1 (nunca tuvieron columnas documentadas)", () => {
    expect(SCHEMA_DOCUMENTED_TABLES).not.toContain("OIGN")
    expect(SCHEMA_DOCUMENTED_TABLES).not.toContain("IGN1")
  })

  it("SCHEMA_DOCUMENTED_TABLES sí incluye las tablas con columnas documentadas en system-prompt.ts", () => {
    for (const t of ["OINV", "INV1", "ORDR", "RDR1", "OPOR", "POR1", "OCRD", "OITM", "ORCT", "OWOR", "WOR1", "ORSC"]) {
      expect(SCHEMA_DOCUMENTED_TABLES).toContain(t)
    }
  })

  it("extractSapTableNames detecta las tablas SAP mencionadas en la query e ignora palabras clave SQL", () => {
    const sql = "SELECT T0.\"DocNum\" FROM OIGN T0 INNER JOIN IGN1 T1 ON T0.\"DocEntry\" = T1.\"DocEntry\" WHERE T0.\"DocDate\" > '2026-01-01' ORDER BY T0.\"DocNum\""
    const tables = extractSapTableNames(sql)
    expect(tables).toContain("OIGN")
    expect(tables).toContain("IGN1")
    expect(tables).not.toContain("ORDER")
    expect(tables).not.toContain("WHERE")
    expect(tables).not.toContain("FROM")
    expect(tables).not.toContain("JOIN")
    expect(tables).not.toContain("INNER")
  })

  describe("findUndiscoveredTables (gate de consultar_sql)", () => {
    it("(a) una tabla documentada (OITM) no requiere descubrir_esquema previo", () => {
      const discoveredTables = new Set<string>(SCHEMA_DOCUMENTED_TABLES)
      const sql = "SELECT \"ItemCode\", \"ItemName\", \"OnHand\" FROM OITM WHERE \"SellItem\" = 'Y'"
      const undiscovered = findUndiscoveredTables(sql, discoveredTables)
      expect(undiscovered).toEqual([])
    })

    it("(b) una tabla no documentada (OIGN) es bloqueada hasta llamar descubrir_esquema", () => {
      const discoveredTables = new Set<string>(SCHEMA_DOCUMENTED_TABLES)
      const sql = "SELECT T0.\"DocNum\", T0.\"Remarks\" FROM OIGN T0"

      // Antes de descubrir_esquema('OIGN'): el gate debe bloquear.
      const undiscoveredBefore = findUndiscoveredTables(sql, discoveredTables)
      expect(undiscoveredBefore).toContain("OIGN")

      // Simula lo que hace la tool descubrir_esquema (route.ts): agrega la
      // tabla consultada a discoveredTables — recién ahí el gate deja pasar.
      discoveredTables.add("OIGN")
      const undiscoveredAfter = findUndiscoveredTables(sql, discoveredTables)
      expect(undiscoveredAfter).toEqual([])
    })

    it("bloquea si SOLO una de varias tablas de un JOIN no está documentada", () => {
      const discoveredTables = new Set<string>(SCHEMA_DOCUMENTED_TABLES)
      // OINV sí documentada, OIGN no.
      const sql = "SELECT T0.\"DocNum\" FROM OINV T0 INNER JOIN OIGN T1 ON T0.\"DocEntry\" = T1.\"DocEntry\""
      const undiscovered = findUndiscoveredTables(sql, discoveredTables)
      expect(undiscovered).toEqual(["OIGN"])
    })
  })
})
