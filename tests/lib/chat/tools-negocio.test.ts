import { describe, it, expect, vi } from "vitest"
import { BackendError } from "@ai4u/contracts"
import { createNegocioTools, KPI_IDS, KPI_CATALOG, resolvePeriodo } from "@/lib/chat/tools/negocio"

/**
 * Tools de negocio (lib/chat/tools/negocio.ts): reutilizan los endpoints que ya
 * consume Mission Control (Pulse/Finanzas/Producción) en sap-b1-backend. Lo que
 * se prueba acá es el contrato con el backend (ruta + query params exactos,
 * incluido excludedDates para cuadrar con Pulse), que kpi_negocio devuelve la
 * `definicion` de negocio, y que cualquier error pasa por classifySapError.
 */

type AnyTool = { execute?: (input: unknown, opts: unknown) => unknown }
const run = (t: unknown, input: unknown) =>
  (t as AnyTool).execute!(input, { toolCallId: "tc-1", messages: [] }) as Promise<Record<string, unknown>>

function setup(response: unknown = { data: [] }, opts: { excludedDates?: string[] } = {}) {
  const get = vi.fn<(path: string) => Promise<unknown>>(async () => response)
  const status = vi.fn()
  const tools = createNegocioTools({
    get: get as unknown as <T>(path: string) => Promise<T>,
    status,
    excludedDates: opts.excludedDates,
    today: () => "2026-09-29",
  })
  return { get, status, tools }
}

const kpisResponse = {
  data: [
    { id: "ventas_mes_actual", name: "Facturación", unit: "currency", value: 1500, previousValue: 1000, trend: 50 },
    { id: "cartera_vencida", name: "Cartera vencida", unit: "currency", value: 700, previousValue: null, trend: null },
  ],
  meta: { periodFrom: "2026-09-01", periodTo: "2026-09-30" },
}

describe("resolvePeriodo", () => {
  it("sin fechas → mes en curso (1 → hoy, Bogotá)", () => {
    expect(resolvePeriodo(undefined, undefined, "2026-09-29")).toEqual({ desde: "2026-09-01", hasta: "2026-09-29", porDefecto: true })
  })
  it("solo una fecha → error accionable", () => {
    expect(resolvePeriodo("2026-01-01", undefined, "2026-09-29")).toHaveProperty("error.code", "INVALID_PERIOD")
  })
  it("rango invertido → error", () => {
    expect(resolvePeriodo("2026-05-01", "2026-04-01", "2026-09-29")).toHaveProperty("error.code", "INVALID_PERIOD")
  })
})

describe("kpi_negocio", () => {
  it("solo expone ids que existen en el registry del backend (sin 'margen', que no existe)", () => {
    expect(KPI_IDS).toContain("ventas_mes_actual")
    expect(KPI_IDS).toContain("ventas_ytd")
    expect(KPI_IDS).toContain("cartera_vencida")
    expect(KPI_IDS).not.toContain("margen")
    expect(KPI_IDS).toHaveLength(29)
  })

  it("sin periodo llama /kpis sin from/to (mismo default y misma caché que Pulse)", async () => {
    const { get, tools } = setup(kpisResponse)
    await run(tools.kpi_negocio, { kpiId: "ventas_mes_actual" })
    expect(get).toHaveBeenCalledWith("/kpis")
  })

  it("con periodo, yoy y excludedDates del tenant arma la URL exacta (url-encoded)", async () => {
    const { get, tools } = setup(kpisResponse, { excludedDates: ["2026-01-01"] })
    await run(tools.kpi_negocio, { kpiId: "ventas_mes_actual", desde: "2026-01-01", hasta: "2026-06-30", compararAnioAnterior: true })
    expect(get).toHaveBeenCalledWith("/kpis?from=2026-01-01&to=2026-06-30&compare=yoy&excludedDates=2026-01-01")
  })

  it("devuelve el valor del KPI pedido + definicion de negocio + periodo del backend", async () => {
    const { tools } = setup(kpisResponse)
    const out = await run(tools.kpi_negocio, { kpiId: "ventas_mes_actual" })
    expect(out.kpi).toMatchObject({ id: "ventas_mes_actual", valor: 1500, valorPeriodoAnterior: 1000, variacionPct: 50 })
    expect(out.definicion).toBe(KPI_CATALOG.ventas_mes_actual.definicion)
    expect(String(out.definicion)).toMatch(/sin IVA/)
    expect(String(out.definicion)).toMatch(/notas crédito/)
    expect(out.periodo).toMatchObject({ desde: "2026-09-01", hasta: "2026-09-30", porDefecto: true })
  })

  it("detalle=true pide /kpis/{id}/detail con el periodo que devolvió la tarjeta y recorta a 50 filas", async () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({ CardCode: `C${i}`, NetoSinIVA: i }))
    const get = vi.fn(async (path: string) => (path.startsWith("/kpis/") ? { kpiId: "ventas_mes_actual", name: "F", columns: [], rows } : kpisResponse))
    const tools = createNegocioTools({ get: get as never, status: vi.fn(), excludedDates: ["2026-01-01"], today: () => "2026-09-29" })
    const out = await run(tools.kpi_negocio, { kpiId: "ventas_mes_actual", detalle: true })
    expect(get).toHaveBeenNthCalledWith(2, "/kpis/ventas_mes_actual/detail?from=2026-09-01&to=2026-09-30&excludedDates=2026-01-01")
    expect(out.detalle).toMatchObject({ totalFilas: 60, truncado: true })
    expect((out.detalle as { filas: unknown[] }).filas).toHaveLength(50)
  })

  it("KPI con error en el backend → advertencia, no se presenta como cifra real", async () => {
    const { tools } = setup({ data: [{ id: "ventas_hoy", name: "Hoy", unit: "currency", value: 0, previousValue: null, trend: null, error: "SAP timeout" }], meta: {} })
    const out = await run(tools.kpi_negocio, { kpiId: "ventas_hoy" })
    expect(out.advertencia).toMatch(/no está disponible/)
  })

  it("solo una fecha → INVALID_PERIOD sin llamar al backend", async () => {
    const { get, tools } = setup(kpisResponse)
    const out = await run(tools.kpi_negocio, { kpiId: "ventas_ytd", desde: "2026-01-01" })
    expect(out).toHaveProperty("error.code", "INVALID_PERIOD")
    expect(get).not.toHaveBeenCalled()
  })

  it("un error del backend pasa por classifySapError (timeout → SAP_TIMEOUT retryable)", async () => {
    const get = vi.fn(async () => { throw new Error("timeout: SAP B1 no respondió en 75000ms") })
    const tools = createNegocioTools({ get: get as never, status: vi.fn(), today: () => "2026-09-29" })
    const out = await run(tools.kpi_negocio, { kpiId: "ventas_mes_actual" })
    expect(out).toEqual({ error: expect.objectContaining({ code: "SAP_TIMEOUT", retryable: true }) })
  })
})

describe("tools de insights — URL y params verificados contra sap-b1-backend", () => {
  const ex = { excludedDates: ["2026-01-01"] }

  it("tendencia_facturacion → /kpis/sales-trend con excludedDates", async () => {
    const { get, tools } = setup({ salesTrend: [{ year: 2026, month: 1, total: 10 }] }, ex)
    const out = await run(tools.tendencia_facturacion, {})
    expect(get).toHaveBeenCalledWith("/kpis/sales-trend?excludedDates=2026-01-01")
    expect(out.serie).toEqual([{ year: 2026, month: 1, total: 10 }])
    expect(out.definicion).toMatch(/sin IVA/)
  })

  it("top_clientes → /insights/top-customers?from&to&limit&excludedDates (default mes en curso, limit 10)", async () => {
    const { get, tools } = setup({ data: [{ cardCode: "C1", total: 5 }] }, ex)
    const out = await run(tools.top_clientes, {})
    expect(get).toHaveBeenCalledWith("/insights/top-customers?from=2026-09-01&to=2026-09-29&limit=10&excludedDates=2026-01-01")
    expect(out.clientes).toEqual([{ cardCode: "C1", total: 5 }])
    expect(out.definicion).toMatch(/Venta neta sin IVA/)
  })

  it("ventas_cliente_mensual → /insights/sales-by-customer-monthly y filtra por cardCode", async () => {
    const cells = [
      { mes: "2026-02", cardCode: "C1", total: 10 },
      { mes: "2026-01", cardCode: "C1", total: 5 },
      { mes: "2026-01", cardCode: "C2", total: 99 },
    ]
    const { get, tools } = setup({ data: cells }, ex)
    const out = await run(tools.ventas_cliente_mensual, { desde: "2026-01-01", hasta: "2026-06-30", cardCode: "C1" })
    expect(get).toHaveBeenCalledWith("/insights/sales-by-customer-monthly?from=2026-01-01&to=2026-06-30&excludedDates=2026-01-01")
    expect(out.celdas).toEqual([
      { mes: "2026-01", cardCode: "C1", total: 5 },
      { mes: "2026-02", cardCode: "C1", total: 10 },
    ])
    expect(out.clientesEnPeriodo).toBe(2)
  })

  it("ventas_cliente_mensual sin cardCode → solo los N clientes de mayor venta", async () => {
    const cells = [
      { mes: "2026-01", cardCode: "A", total: 1 },
      { mes: "2026-01", cardCode: "B", total: 50 },
      { mes: "2026-02", cardCode: "C", total: 20 },
    ]
    const { tools } = setup({ data: cells })
    const out = await run(tools.ventas_cliente_mensual, { topClientes: 2 })
    expect((out.celdas as { cardCode: string }[]).map((c) => c.cardCode)).toEqual(["B", "C"])
  })

  it("ventas_por_vendedor modo ranking → /insights/top-salespeople", async () => {
    const { get, tools } = setup({ data: [] }, ex)
    await run(tools.ventas_por_vendedor, { modo: "ranking", desde: "2026-07-01", hasta: "2026-07-31", limite: 5 })
    expect(get).toHaveBeenCalledWith("/insights/top-salespeople?from=2026-07-01&to=2026-07-31&limit=5&excludedDates=2026-01-01")
  })

  it("ventas_por_vendedor modo presupuesto → /insights/sales-vs-budget?year (default año en curso Bogotá)", async () => {
    const { get, tools } = setup({ data: { available: true } }, ex)
    const out = await run(tools.ventas_por_vendedor, { modo: "presupuesto" })
    expect(get).toHaveBeenCalledWith("/insights/sales-vs-budget?year=2026&excludedDates=2026-01-01")
    expect(out.presupuesto).toEqual({ available: true })
  })

  it("cartera_deudores → /receivables/top-debtors?limit y /receivables/upcoming", async () => {
    const { get, tools } = setup({ data: [] })
    await run(tools.cartera_deudores, { modo: "mayores_deudores", limite: 7 })
    await run(tools.cartera_deudores, { modo: "por_vencer" })
    expect(get).toHaveBeenNthCalledWith(1, "/receivables/top-debtors?limit=7")
    expect(get).toHaveBeenNthCalledWith(2, "/receivables/upcoming")
  })

  it("cartera_deudores aclara que los montos incluyen IVA", async () => {
    const { tools } = setup({ data: [] })
    const out = await run(tools.cartera_deudores, { modo: "mayores_deudores" })
    expect(out.nota).toMatch(/con IVA/i)
  })

  it("estado_resultados pyg → /finance/pnl?from&to&excludedDates y descarta campos internos", async () => {
    const { get, tools } = setup({ from: "2026-01-01", to: "2026-06-30", totals: { utilidadNeta: 1 }, childCodes: {}, creditByMonth: [1] }, ex)
    const out = await run(tools.estado_resultados, { modo: "pyg", desde: "2026-01-01", hasta: "2026-06-30" })
    expect(get).toHaveBeenCalledWith("/finance/pnl?from=2026-01-01&to=2026-06-30&excludedDates=2026-01-01")
    expect(out.pyg).toEqual({ from: "2026-01-01", to: "2026-06-30", totals: { utilidadNeta: 1 } })
  })

  it("estado_resultados indicadores → /finance/ratios; anual_puc → /finance/estado-resultados?year recortado a 2 niveles", async () => {
    const arbol = {
      year: 2026, monthsIncluded: 9,
      raices: [{ codigo: "4", nombre: "Ingresos", totalAnio: 10, hijos: [{ codigo: "41", nombre: "Op", totalAnio: 10, hijos: [{ codigo: "4120", nombre: "x", totalAnio: 10 }] }] }],
    }
    const get = vi.fn(async (path: string) => (path.startsWith("/finance/estado-resultados") ? arbol : { roe: 1 }))
    const tools = createNegocioTools({ get: get as never, status: vi.fn(), excludedDates: ["2026-01-01"], today: () => "2026-09-29" })
    await run(tools.estado_resultados, { modo: "indicadores" })
    const puc = await run(tools.estado_resultados, { modo: "anual_puc" })
    expect(get).toHaveBeenNthCalledWith(1, "/finance/ratios?excludedDates=2026-01-01")
    expect(get).toHaveBeenNthCalledWith(2, "/finance/estado-resultados?year=2026&excludedDates=2026-01-01")
    const cuentas = puc.cuentas as { hijos?: { hijos?: unknown }[] }[]
    expect(cuentas[0].hijos?.[0]).not.toHaveProperty("hijos")
  })

  it("produccion_indicadores → production-kpis / variance / delivery-compliance con from&to", async () => {
    const { get, tools } = setup({ data: { resumen: {}, days: [], cerradas: [], rows: [] } })
    await run(tools.produccion_indicadores, { modo: "resumen" })
    await run(tools.produccion_indicadores, { modo: "variacion", desde: "2026-08-01", hasta: "2026-08-31" })
    await run(tools.produccion_indicadores, { modo: "cumplimiento_entregas", desde: "2026-08-01", hasta: "2026-08-31" })
    expect(get).toHaveBeenNthCalledWith(1, "/insights/production-kpis?from=2026-09-01&to=2026-09-29")
    expect(get).toHaveBeenNthCalledWith(2, "/production/variance?from=2026-08-01&to=2026-08-31")
    expect(get).toHaveBeenNthCalledWith(3, "/insights/delivery-compliance?from=2026-08-01&to=2026-08-31")
  })

  it("produccion_indicadores variacion resume GANANCIA/PERDIDA y ordena por desviación absoluta", async () => {
    const rows = [
      { docNum: 1, status: "GANANCIA", deviationTotal: 10 },
      { docNum: 2, status: "PERDIDA", deviationTotal: -50 },
      { docNum: 3, status: null, deviationTotal: null },
    ]
    const { tools } = setup({ rows, costTruncated: false, metrosDisponible: true })
    const out = await run(tools.produccion_indicadores, { modo: "variacion" })
    expect(out.resumen).toEqual({ ops: 3, ganancia: 1, perdida: 1, desviacionTotal: -40 })
    expect((out.mayoresDesviaciones as { filas: { docNum: number }[] }).filas[0].docNum).toBe(2)
  })

  it("sin excludedDates en el tenant no manda el param", async () => {
    const { get, tools } = setup({ data: [] })
    await run(tools.top_clientes, { desde: "2026-01-01", hasta: "2026-01-31", limite: 3 })
    expect(get).toHaveBeenCalledWith("/insights/top-customers?from=2026-01-01&to=2026-01-31&limit=3")
  })

  it.each([
    ["tendencia_facturacion", {}],
    ["top_clientes", {}],
    ["ventas_cliente_mensual", {}],
    ["ventas_por_vendedor", { modo: "ranking" }],
    ["cartera_deudores", { modo: "por_vencer" }],
    ["estado_resultados", { modo: "indicadores" }],
    ["produccion_indicadores", { modo: "resumen" }],
  ])("%s: un error del backend pasa por classifySapError", async (name, input) => {
    const get = vi.fn(async () => {
      throw new BackendError("GET", "/x", 400, JSON.stringify({ error: "from/to requeridos (YYYY-MM-DD)" }), "rid-1")
    })
    const tools = createNegocioTools({ get: get as never, status: vi.fn(), today: () => "2026-09-29" }) as Record<string, unknown>
    const out = await run(tools[name], input)
    expect(out).toEqual({ error: expect.objectContaining({ code: "BAD_REQUEST", requestId: "rid-1" }) })
  })
})
