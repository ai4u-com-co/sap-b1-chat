import { describe, it, expect } from "vitest"
import { buildStaticSystemPrompt } from "@/lib/chat/system-prompt"

/**
 * Evidencia de producción (Flexo, 29-sep-2026): "¿cuánto le hemos comprado?" se
 * respondió con SUM(DocTotal) FROM OPCH sin CANCELED='N' ni restar ORPC. El prompt
 * debe rutear compras a compras_proveedor y, si hay SQL, fijar OPCH − ORPC con
 * CANCELED = 'N' y exigir decir con/sin IVA — sin romper la regla de ventas.
 */
describe("system-prompt — cifras de compras con la misma disciplina que ventas", () => {
  for (const tenant of ["tamaprint", "flexoimpresos"]) {
    describe(tenant, () => {
      const prompt = buildStaticSystemPrompt(tenant)
      const start = prompt.indexOf("## CIFRAS DE COMPRAS Y PROVEEDORES — RUTEO OBLIGATORIO")
      const end = prompt.indexOf("## SCHEMA DE TABLAS CORE")
      const seccion = prompt.slice(start, end)

      it("tiene la sección de ruteo de compras, después de la de ventas y antes del schema", () => {
        const ventas = prompt.indexOf("## CIFRAS DE VENTA Y FACTURACIÓN — RUTEO OBLIGATORIO")
        expect(ventas).toBeGreaterThan(-1)
        expect(start).toBeGreaterThan(ventas)
        expect(start).toBeLessThan(end)
      })

      it("rutea a compras_proveedor y a buscar_socio_o_item primero", () => {
        expect(seccion).toMatch(/\*\*compras_proveedor\*\* modo='facturas'/)
        expect(seccion).toMatch(/\*\*buscar_socio_o_item\*\*/)
      })

      it("fija la regla SQL: OPCH − ORPC con CANCELED = 'N'", () => {
        expect(seccion).toMatch(/SUM\(PCH1\.LineTotal\) de OPCH − SUM\(RPC1\.LineTotal\) de ORPC/)
        expect(seccion).toMatch(/CANCELED = 'N'/)
        expect(seccion).toMatch(/Nunca SUM\(OPCH\.DocTotal\)/)
      })

      it("exige decir si la cifra de compras es con o sin IVA", () => {
        expect(seccion).toMatch(/con o sin IVA/)
      })

      it("aclara que compras_por_proveedor del catálogo mide órdenes de compra", () => {
        expect(seccion).toMatch(/compras_por_proveedor\*\* suma ÓRDENES de compra \(OPOR\)/)
      })

      it("el patrón SQL de compras resta ORPC/RPC1 y filtra CANCELED en ambas queries", () => {
        const p0 = prompt.indexOf("## PATRONES SQL — COMPRAS")
        const p1 = prompt.indexOf("## PATRONES SQL — MARGEN BRUTO")
        const bloque = prompt.slice(p0, p1)
        expect(p0).toBeGreaterThan(-1)
        expect(bloque).toMatch(/FROM OPCH H INNER JOIN PCH1 L/)
        expect(bloque).toMatch(/FROM ORPC H INNER JOIN RPC1 L/)
        expect(bloque.match(/H\.CANCELED = 'N'/g)?.length).toBe(2)
        expect(bloque).not.toMatch(/SELECT[^;]*DocTotal/)
      })

      it("la regla de ventas sigue intacta (una sola sección, kpi_negocio primero)", () => {
        expect(prompt.split("## CIFRAS DE VENTA Y FACTURACIÓN — RUTEO OBLIGATORIO").length).toBe(2)
        expect(prompt.split("## CIFRAS DE COMPRAS Y PROVEEDORES — RUTEO OBLIGATORIO").length).toBe(2)
        expect(prompt).toMatch(/usa PRIMERO \*\*kpi_negocio\*\*/)
      })

      it("no incluye CardCodes reales de un tenant en los ejemplos", () => {
        expect(prompt).not.toContain("P8026979")
      })
    })
  }
})
