import { describe, it, expect } from "vitest"
import { buildStaticSystemPrompt, buildFechaActual } from "@/lib/chat/system-prompt"

/**
 * El chat respondía "ventas" con cifras que no cuadraban con Pulse: medía PEDIDOS
 * (analisis_ventas/tendencia_ventas), sumaba DocTotal con IVA (catálogo) o, en SQL
 * libre, "quitaba el IVA" dividiendo por 1.19. Estos tests fijan las reglas del
 * prompt que corrigen eso: ruteo a kpi_negocio, prohibición de ÷1.19, definición
 * de Pulse en los patrones SQL y aclaración de que la cartera incluye IVA.
 */
describe("system-prompt — cifras de venta alineadas con Pulse", () => {
  for (const tenant of ["tamaprint", "flexoimpresos"]) {
    describe(tenant, () => {
      const prompt = buildStaticSystemPrompt(tenant)

      it("prioriza kpi_negocio para cifras de venta/facturación", () => {
        expect(prompt).toMatch(/usa PRIMERO \*\*kpi_negocio\*\*/)
        const ruteo = prompt.indexOf("RUTEO OBLIGATORIO")
        const sqlPatterns = prompt.indexOf("PATRONES SQL — FACTURACIÓN")
        expect(ruteo).toBeGreaterThan(-1)
        // La regla de ruteo va antes del schema y de los patrones SQL.
        expect(ruteo).toBeLessThan(sqlPatterns)
      })

      it("prohíbe explícitamente aproximar el IVA dividiendo por 1.19", () => {
        expect(prompt).toMatch(/PROHIBIDO aproximar el IVA dividiendo por 1\.19/)
        expect(prompt).toMatch(/DocTotal − VatSum/)
      })

      it("no contiene ningún ejemplo SQL que divida por 1.19", () => {
        expect(prompt).not.toMatch(/\/\s*1\.19/)
      })

      it("aclara que analisis_ventas y tendencia_ventas miden pedidos", () => {
        expect(prompt).toMatch(/\*\*analisis_ventas\*\* y \*\*tendencia_ventas\*\* miden PEDIDOS/)
      })

      it("aclara que cartera y cuentas por pagar incluyen IVA y no es inconsistencia", () => {
        expect(prompt).toMatch(/SÍ incluyen IVA/)
        expect(prompt).toMatch(/NO es una inconsistencia/)
      })

      it("los patrones de venta usan la definición de Pulse (LineTotal, TaxDate, CANCELED, ORIN)", () => {
        const start = prompt.indexOf("## PATRONES SQL — FACTURACIÓN / VENTAS")
        const end = prompt.indexOf("## PATRONES SQL — MARGEN BRUTO")
        const bloque = prompt.slice(start, end)
        expect(bloque).toMatch(/SUM\(L\.LineTotal\)/)
        expect(bloque).toMatch(/TaxDate/)
        expect(bloque).toMatch(/ORIN H INNER JOIN RIN1 L/)
        // Ningún SELECT de ejemplo suma DocTotal (la prosa sí lo nombra para prohibirlo).
        expect(bloque).not.toMatch(/SELECT[^\n]*SUM\(DocTotal\)/)
      })

      it("toda query de ejemplo sobre OINV en los patrones de ventas filtra CANCELED = 'N'", () => {
        const secciones = [
          ["## PATRONES SQL — FACTURACIÓN / VENTAS", "## PATRONES SQL — MARGEN BRUTO"],
          ["## PATRONES SQL — COMPARACIÓN ENTRE PERÍODOS", null],
        ] as const
        for (const [ini, fin] of secciones) {
          const s = prompt.indexOf(ini)
          const bloque = prompt.slice(s, fin ? prompt.indexOf(fin) : undefined)
          const queries = bloque.split(/\n\s*\n|UNION ALL/).filter((q) => /FROM (OINV|ORIN)/.test(q))
          expect(queries.length).toBeGreaterThan(0)
          for (const q of queries) expect(q).toMatch(/CANCELED = 'N'/)
        }
      })

      it("declara un solo dialecto (HANA), sin la instrucción vieja de 'SQL Server restrictiva'", () => {
        expect(prompt).not.toMatch(/sintaxis SQL Server restrictiva/)
        expect(prompt).toMatch(/El SQL es \*\*SAP HANA\*\*/)
      })
    })
  }

  it("la fecha sigue en un bloque aparte (no rompe el split de 2 mensajes system para caching)", () => {
    const prompt = buildStaticSystemPrompt("tamaprint")
    expect(prompt).not.toMatch(/Fecha actual:/)
    expect(buildFechaActual()).toMatch(/^Fecha actual: /)
  })
})
