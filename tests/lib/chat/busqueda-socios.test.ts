import { describe, it, expect } from "vitest"
import {
  buildBusquedaPath,
  caseVariants,
  documentoNumerico,
  tokenize,
} from "@/lib/chat/busqueda-socios"

/**
 * Evidencia de producción (Flexo, 29-sep-2026): "Mariano Garcia" devolvía 0 aunque
 * el socio existe como "GARCIA POSADA MARIANO" (P8026979) — el texto se buscaba
 * como una sola subcadena y con las mayúsculas del usuario. Estos tests fijan el
 * filtro OData que arregla eso.
 */

const filterOf = (path: string) => path.slice(path.indexOf("$filter=") + "$filter=".length)

describe("buscar_socio_o_item — filtro tolerante al orden y a mayúsculas", () => {
  it("regresión: 'Mariano Garcia' ya NO busca la frase completa como una subcadena", () => {
    const { path } = buildBusquedaPath("proveedor", "Mariano Garcia", 10)
    expect(path).not.toContain("'Mariano Garcia'")
  })

  it("una cláusula por palabra, unidas con AND, cada una con su variante en MAYÚSCULAS", () => {
    const { path } = buildBusquedaPath("proveedor", "Mariano Garcia", 10)
    const f = filterOf(path)
    expect(f.startsWith("(CardType eq 'cSupplier') and (")).toBe(true)
    expect(f).toContain("contains(CardName,'MARIANO')")
    expect(f).toContain("contains(CardName,'GARCIA')")
    expect(f).toContain("contains(CardName,'mariano')")
    expect(f).toContain(") and (")
    // El nombre real en SAP contiene ambas variantes en mayúsculas → coincide.
    const nombreSap = "GARCIA POSADA MARIANO"
    expect(nombreSap.includes("MARIANO") && nombreSap.includes("GARCIA")).toBe(true)
  })

  it("el orden de las palabras no cambia el conjunto de cláusulas", () => {
    const a = filterOf(buildBusquedaPath("proveedor", "Mariano Garcia", 10).path)
    const b = filterOf(buildBusquedaPath("proveedor", "garcia MARIANO", 10).path)
    const clauses = (f: string) => new Set(f.match(/contains\(CardName,'[^']*'\)/g)?.map((c) => c.toUpperCase()))
    expect(clauses(a)).toEqual(clauses(b))
  })

  it("variantes: original, MAYÚSCULAS, minúsculas, Título y sin tildes", () => {
    expect(caseVariants("García")).toEqual(
      expect.arrayContaining(["García", "GARCÍA", "garcía", "GARCIA", "garcia", "Garcia"]),
    )
    const { path } = buildBusquedaPath("cliente", "José Pérez", 10)
    expect(path).toContain("contains(CardName,'JOSE')")
    expect(path).toContain("contains(CardName,'PÉREZ')")
    expect(path).toContain("CardType eq 'cCustomer'")
  })

  it("tipo='socio' no filtra por CardType e incluye LicTradNum/CardType en el $select", () => {
    const { path } = buildBusquedaPath("socio", "Garcia", 5)
    expect(path).not.toContain("CardType eq")
    expect(path).toContain("$select=CardCode,CardName,CardType,LicTradNum,")
    expect(path).toContain("$top=5")
  })

  it("descarta stopwords y limita a 4 palabras (las más largas)", () => {
    expect(tokenize("Industrias de la Costa y del Caribe S.A.S")).toEqual(["Industrias", "Caribe", "Costa"])
    expect(tokenize("uno dos tres cuatro cinco seis")).toHaveLength(4)
  })

  it("texto numérico busca por NIT (LicTradNum) y CardCode", () => {
    const { path, criterio } = buildBusquedaPath("proveedor", "8026979", 10)
    expect(filterOf(path)).toBe("(CardType eq 'cSupplier') and (contains(LicTradNum,'8026979') or contains(CardCode,'8026979'))")
    expect(criterio).toContain("LicTradNum")
  })

  it("NIT con puntos y dígito de verificación → solo el número principal", () => {
    expect(documentoNumerico("900.123.456-7")).toBe("900123456")
    expect(documentoNumerico("8 026 979")).toBe("8026979")
    expect(documentoNumerico("P8026979")).toBeNull()
    expect(documentoNumerico("12")).toBeNull()
    expect(filterOf(buildBusquedaPath("socio", "900.123.456-7", 10).path)).toBe(
      "contains(LicTradNum,'900123456') or contains(CardCode,'900123456')",
    )
  })

  it("escapa comillas simples en todas las variantes", () => {
    const { path } = buildBusquedaPath("cliente", "D'Angelo O'Brien", 10)
    expect(path).toContain("contains(CardName,'D''ANGELO')")
    expect(path).toContain("contains(CardName,'O''Brien')")
    // Ninguna comilla simple suelta dentro de un literal.
    for (const lit of filterOf(path).match(/'(?:[^']|'')*'/g) ?? []) {
      expect(lit.slice(1, -1).replace(/''/g, "")).not.toContain("'")
    }
  })

  it("elimina caracteres de control y acota el largo del path", () => {
    const { path } = buildBusquedaPath("socio", "a\u0000bc " + "x".repeat(300), 10)
    expect(path).not.toMatch(/[\x00-\x1f]/)
    expect(path.length).toBeLessThanOrEqual(1900)
  })

  it("artículos: misma lógica por palabra sobre ItemName/ItemCode", () => {
    const { path } = buildBusquedaPath("item", "etiqueta blanca", 10)
    expect(path.startsWith("/Items?$select=ItemCode,ItemName,AvgStdPrice,QuantityOnStock&$top=10&$filter=")).toBe(true)
    expect(path).toContain("contains(ItemName,'ETIQUETA')")
    expect(path).toContain("contains(ItemName,'BLANCA')")
    expect(path).toContain("contains(ItemCode,'ETIQUETA')")
  })
})
