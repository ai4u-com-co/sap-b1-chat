import { describe, it, expect } from "vitest"
import { buildStaticSystemPrompt } from "@/lib/chat/system-prompt"

/**
 * Regresión de un error real de producción (tenant flexo, 2026-08-14):
 *
 *   SAP GET /Invoices?...&$select=...,DiscSum,... → 400 (-1000)
 *   "Property DiscSum of Document is invalid"
 *
 * El LLM copió `DiscSum` de la tabla SQL `OINV` (documentada en la sección
 * "SCHEMA DE TABLAS CORE", para `consultar_sql`) y la usó como `$select` de
 * OData contra la entidad `Invoices` (tool `obtener_documento`/
 * `listar_registros`) — pero `DiscSum` no existe como propiedad OData del
 * EntityType `Document`; el nombre OData real es `TotalDiscount`.
 *
 * Estos tests prueban que el prompt documenta explícitamente la
 * equivalencia SQL↔OData para que el LLM deje de confundirlas, en los tres
 * lugares donde ya se corrigió el mismo tipo de confusión (ver PR #20 para
 * el precedente: AvgStdPrice/Dscription/CompletedQty).
 */
describe("system-prompt — DiscSum (SQL) vs TotalDiscount (OData)", () => {
  const prompt = buildStaticSystemPrompt("flexoimpresos")

  it("sigue documentando DiscSum como columna SQL de OINV (no se rompió el schema SQL)", () => {
    expect(prompt).toMatch(/\|\s*DiscSum\s*\|.*Descuento total aplicado/)
  })

  it("advierte junto a DiscSum que el nombre OData equivalente es TotalDiscount", () => {
    const discSumIdx = prompt.indexOf("| DiscSum |")
    expect(discSumIdx).toBeGreaterThan(-1)
    const nearby = prompt.slice(discSumIdx, discSumIdx + 600)
    expect(nearby).toContain("TotalDiscount")
    expect(nearby).toMatch(/OData/)
  })

  it("la sección de PARÁMETROS ODATA (select de obtener_documento/listar_registros) menciona TotalDiscount y no recomienda DiscSum", () => {
    const paramsIdx = prompt.indexOf("## PARÁMETROS ODATA")
    expect(paramsIdx).toBeGreaterThan(-1)
    const section = prompt.slice(paramsIdx, paramsIdx + 800)
    expect(section).toContain("TotalDiscount")
  })

  it("la nota general de discrepancias OData vs SQLQueries incluye el ejemplo DiscSum/TotalDiscount", () => {
    expect(prompt).toContain("OINV.DiscSum (SQL) es TotalDiscount en OData")
  })
})
