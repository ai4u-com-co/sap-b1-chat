import { describe, it, expect } from "vitest"
import { classifyColumnNotFound, parseColumnNotFound, suggestColumns } from "@/lib/chat/sql-error-hints"

// Mensajes tal cual quedaron en platform_logs (sap-b1-backend, sep-2026): el
// error de SAP llega dentro de un JSON anidado, con comillas escapadas o no.
const msg703 = (col: string, table: string, quoted = true) =>
  `Backend POST /query (500): SAP SQLQueries POST falló (400): { "error" : { "code" : "703", ` +
  `"details" : [ { "code" : "", "message" : "" } ], ` +
  `"message" : "Column '${quoted ? `\\"${col}\\"` : col}' from table '${table}' not exist." } }`

describe("parseColumnNotFound", () => {
  it("extrae columna y tabla con comillas escapadas (\\\"Remarks\\\")", () => {
    expect(parseColumnNotFound(msg703("Remarks", "OWOR"))).toEqual({ column: "Remarks", table: "OWOR" })
  })

  it("extrae columna y tabla sin comillas internas", () => {
    expect(parseColumnNotFound(msg703("DocDate", "OWOR", false))).toEqual({ column: "DocDate", table: "OWOR" })
  })

  it("normaliza la tabla a mayúsculas y acepta UDFs", () => {
    expect(parseColumnNotFound(msg703("U_AI4U_CobroExcl", "ocrd"))).toEqual({ column: "U_AI4U_CobroExcl", table: "OCRD" })
  })

  it("devuelve null para cualquier otro error", () => {
    expect(parseColumnNotFound("SAP: timeout tras 30000ms")).toBeNull()
    expect(parseColumnNotFound('{ "error": { "code": "702", "message": "Table OITB not accessible" } }')).toBeNull()
    expect(parseColumnNotFound("")).toBeNull()
  })
})

describe("suggestColumns", () => {
  it("sugiere solo las que están dentro del umbral (CardCode queda fuera: distancia 4 > 2)", () => {
    expect(suggestColumns(["CardCode", "CardName", "Balance"], "CardNam")).toEqual(["CardName"])
  })

  it("ordena por distancia cuando hay varias cercanas", () => {
    expect(suggestColumns(["Price1", "Price", "Balance"], "Prise")).toEqual(["Price", "Price1"])
  })

  it("no sugiere nada si nada se parece", () => {
    expect(suggestColumns(["CardCode", "Balance"], "FederalTaxID")).toEqual([])
  })

  it("respeta el máximo", () => {
    expect(suggestColumns(["Price1", "Price2", "Price3", "Price4"], "Price", 2)).toHaveLength(2)
  })
})

describe("classifyColumnNotFound", () => {
  it("OWOR.Remarks (columna inventada real): explica, lista lo documentado y manda a descubrir_esquema", () => {
    const e = classifyColumnNotFound(msg703("Remarks", "OWOR"))!
    expect(e.code).toBe("SAP_COLUMN_NOT_FOUND")
    expect(e.retryable).toBe(true)
    expect(e.message).toContain('"Remarks" NO existe en la tabla OWOR')
    expect(e.message).toContain("CmpltQty") // única columna OWOR documentada en @ai4u/contracts
    expect(e.message).toContain("descubrir_esquema('OWOR')")
    expect(e.message).toMatch(/OData/)
  })

  it.each([
    ["OCRD", "FederalTaxID", "LicTradNum"],
    ["WOR1", "LineType", "ItemType"],
    ["OWOR", "DocDate", "StartDate o CloseDate"],
    ["OPOR", "Cancelled", "CANCELED"],
  ])("alias verificado: %s.%s → %s", (table, bad, good) => {
    const e = classifyColumnNotFound(msg703(bad, table))!
    expect(e.message).toContain(`el nombre correcto es "${good}"`)
  })

  it("los alias por tabla no se aplican en otra tabla (FederalTaxID en OINV no promete LicTradNum)", () => {
    const e = classifyColumnNotFound(msg703("FederalTaxID", "OINV"))!
    expect(e.message).not.toContain("el nombre correcto es")
  })

  it("UDF inexistente: avisa que los UDF cambian por tenant", () => {
    const e = classifyColumnNotFound(msg703("U_AI4U_CobroExcl", "OCRD"))!
    expect(e.message).toMatch(/campo de usuario \(UDF\)/)
    expect(e.message).toMatch(/cambian por tenant/)
  })

  it("mismo nombre con distinto casing: recuerda que HANA distingue mayúsculas", () => {
    const e = classifyColumnNotFound(msg703("CARDCODE", "OCRD"))!
    expect(e.message).toContain('el nombre documentado es "CardCode"')
  })

  it("sugiere una columna documentada parecida (OCRD.CardNam → CardName)", () => {
    const e = classifyColumnNotFound(msg703("CardNam", "OCRD"))!
    expect(e.message).toMatch(/parecidas: CardName/)
  })

  it("tabla sin entrada en el catálogo: no revienta y no inventa columnas documentadas", () => {
    const e = classifyColumnNotFound(msg703("Foo", "OXYZ"), {})!
    expect(e.code).toBe("SAP_COLUMN_NOT_FOUND")
    expect(e.message).not.toContain("Columnas SQL documentadas")
    expect(e.message).toContain("descubrir_esquema('OXYZ')")
  })

  it("acota la lista de columnas documentadas a 15", () => {
    const many = { OBIG: { camposComunes: Array.from({ length: 30 }, (_, i) => ({ campo: `Col${i}` })) } }
    const e = classifyColumnNotFound(msg703("Zzz", "OBIG"), many)!
    expect(e.message).toContain("Col14")
    expect(e.message).not.toContain("Col15")
    expect(e.message).toContain("…")
  })

  it("dígitos como 401/404/702 dentro de la columna no cambian la clasificación", () => {
    for (const col of ["Col401", "Fld404", "X702"]) {
      expect(classifyColumnNotFound(msg703(col, "OINV"))!.code).toBe("SAP_COLUMN_NOT_FOUND")
    }
  })

  it("devuelve null si no es un 703 de columna (timeout, 702, auth, texto libre)", () => {
    for (const m of [
      "SAP: timeout tras 30000ms",
      'error 702 tabla OITB no accesible',
      "Backend GET /x (401): Sesión SAP expirada",
      "cualquier otra cosa",
    ]) {
      expect(classifyColumnNotFound(m)).toBeNull()
    }
  })
})
