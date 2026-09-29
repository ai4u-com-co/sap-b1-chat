import { describe, it, expect, vi } from "vitest"
import { BackendError } from "@ai4u/contracts"
import { createNegocioTools, DEFINICION_COMPRAS, mesesCalendario, normDate } from "@/lib/chat/tools/negocio"

/**
 * compras_proveedor (lib/chat/tools/negocio.ts). Evidencia de producción (Flexo,
 * 29-sep-2026): para "¿cuánto le hemos comprado?" el modelo escribió
 * SUM(DocTotal) FROM OPCH sin CANCELED='N' ni restar notas crédito (ORPC), y tardó
 * 30 s por ser SQL nuevo. Se prueba el contrato exacto con el backend
 * (suppliers/[cardCode]/*, purchasing/invoices, compras/notas-credito), la
 * `definicion` y el manejo de errores.
 */

type AnyTool = { execute?: (input: unknown, opts: unknown) => unknown }
const run = (t: unknown, input: unknown) =>
  (t as AnyTool).execute!(input, { toolCallId: "tc-1", messages: [] }) as Promise<Record<string, unknown>>

function setup(impl: (path: string) => unknown = () => ({}), opts: { excludedDates?: string[] } = {}) {
  const get = vi.fn<(path: string) => Promise<unknown>>(async (path) => impl(path))
  const tools = createNegocioTools({
    get: get as unknown as <T>(path: string) => Promise<T>,
    status: vi.fn(),
    excludedDates: opts.excludedDates,
    today: () => "2026-09-29",
  })
  return { get, tool: tools.compras_proveedor }
}

describe("compras_proveedor — URL exacta por modo", () => {
  it.each([
    ["resumen", {}, "/suppliers/P8026979/summary"],
    ["aging", {}, "/suppliers/P8026979/aging"],
    ["pagos", {}, "/suppliers/P8026979/payments?limit=50"],
    ["pagos", { limite: 20 }, "/suppliers/P8026979/payments?limit=20"],
    ["historial", {}, "/suppliers/P8026979/history?months=12&topN=10"],
    ["historial", { meses: 24, topN: 5 }, "/suppliers/P8026979/history?months=24&topN=5"],
  ])("modo=%s %j → %s, con definicion", async (modo, extra, url) => {
    const { get, tool } = setup(() => ({ cardCode: "P8026979" }))
    const out = await run(tool, { cardCode: "P8026979", modo, ...extra })
    expect(get).toHaveBeenCalledTimes(1)
    expect(get).toHaveBeenCalledWith(url)
    expect(out.definicion).toBe(DEFINICION_COMPRAS[modo as keyof typeof DEFINICION_COMPRAS])
  })

  it("codifica el CardCode en el path", async () => {
    const { get, tool } = setup()
    await run(tool, { cardCode: "P 80/1", modo: "resumen" })
    expect(get).toHaveBeenCalledWith("/suppliers/P%2080%2F1/summary")
  })

  it("las definiciones dicen explícitamente con/sin IVA", () => {
    expect(DEFINICION_COMPRAS.facturas).toMatch(/sin IVA/)
    expect(DEFINICION_COMPRAS.facturas).toMatch(/notas crédito/)
    expect(DEFINICION_COMPRAS.facturas).toMatch(/sin documentos anulados/)
    expect(DEFINICION_COMPRAS.resumen).toMatch(/CON IVA/)
    expect(DEFINICION_COMPRAS.aging).toMatch(/CON IVA/)
    expect(DEFINICION_COMPRAS.pagos).toMatch(/CON IVA/)
  })
})

describe("compras_proveedor — modo facturas (compras netas)", () => {
  const facturasMes = (from: string) => {
    if (from === "2026-01-01") {
      return {
        data: [
          { docNum: 10, docDate: "20260105", cardCode: "P8026979", cardName: "GARCIA POSADA MARIANO", neto: 1000 },
          { docNum: 10, docDate: "20260105", cardCode: "P8026979", cardName: "GARCIA POSADA MARIANO", neto: 1000 }, // duplicado (backend viejo)
          { docNum: 11, docDate: "20260101", cardCode: "P8026979", neto: 999 }, // fecha excluida (saldo inicial)
          { docNum: 12, docDate: "20260110", cardCode: "OTRO", neto: 5000 }, // otro proveedor
        ],
      }
    }
    if (from === "2026-02-01") {
      return { data: [{ docNum: 20, docDate: "2026-02-20", cardCode: "P8026979", neto: 500 }] }
    }
    return { data: [] }
  }
  const notas = {
    data: [
      { DocEntry: 1, DocNum: 1, DocDate: "2026-02-21", Cancelled: "tNO", DocumentLines: [{ LineTotal: 100 }, { LineTotal: 50 }] },
      { DocEntry: 2, DocNum: 2, DocDate: "2026-02-22", Cancelled: "tYES", DocumentLines: [{ LineTotal: 999 }] },
    ],
  }

  it("pide purchasing/invoices mes a mes (mismo rango que Finanzas de MC) y las notas crédito del proveedor", async () => {
    const { get, tool } = setup((p) => (p.startsWith("/purchasing/invoices") ? facturasMes(p.slice(p.indexOf("from=") + 5, p.indexOf("from=") + 15)) : notas))
    await run(tool, { cardCode: "P8026979", modo: "facturas", desde: "2026-01-15", hasta: "2026-03-10" })
    const urls = get.mock.calls.map((c) => c[0])
    expect(urls).toContain("/purchasing/invoices?from=2026-01-01&to=2026-01-31")
    expect(urls).toContain("/purchasing/invoices?from=2026-02-01&to=2026-02-28")
    expect(urls).toContain("/purchasing/invoices?from=2026-03-01&to=2026-03-31")
    const nc = urls.find((u) => u.startsWith("/compras/notas-credito"))!
    const params = new URLSearchParams(nc.slice(nc.indexOf("?") + 1))
    expect(params.get("$filter")).toBe("CardCode eq 'P8026979' and DocDate ge '2026-01-15' and DocDate le '2026-03-10'")
    expect(params.get("$select")).toBe("DocEntry,DocNum,DocDate,Cancelled,DocumentLines")
    expect(params.get("$top")).toBe("500")
  })

  it("filtra por proveedor y periodo, deduplica, excluye fechas de saldo inicial y resta notas crédito no anuladas", async () => {
    const { tool } = setup(
      (p) => (p.startsWith("/purchasing/invoices") ? facturasMes(p.slice(p.indexOf("from=") + 5, p.indexOf("from=") + 15)) : notas),
      { excludedDates: ["2026-01-01"] },
    )
    const out = await run(tool, { cardCode: "P8026979", modo: "facturas", desde: "2026-01-01", hasta: "2026-02-28" })
    expect(out.facturas).toMatchObject({ cantidad: 2, totalSinIva: 1500 })
    expect(out.notasCredito).toEqual({ cantidad: 1, totalSinIva: 150 })
    expect(out.comprasNetasSinIva).toBe(1350)
    expect(out.proveedor).toEqual({ cardCode: "P8026979", cardName: "GARCIA POSADA MARIANO" })
    expect(out.porMes).toEqual([
      { mes: "2026-01", facturas: 1000, cantidad: 1 },
      { mes: "2026-02", facturas: 500, cantidad: 1, notasCredito: 150 },
    ])
    expect(out.definicion).toBe(DEFINICION_COMPRAS.facturas)
    expect((out.advertencias as string[]).join(" ")).toMatch(/saldos iniciales/)
  })

  it("sin fechas usa el año en curso (Bogotá) y lo marca porDefecto", async () => {
    const { get, tool } = setup(() => ({ data: [] }))
    const out = await run(tool, { cardCode: "P1", modo: "facturas" })
    expect(out.periodo).toEqual({ desde: "2026-01-01", hasta: "2026-09-29", porDefecto: true })
    expect(get.mock.calls.filter((c) => c[0].startsWith("/purchasing/invoices"))).toHaveLength(9)
  })

  it("rechaza más de 24 meses sin llamar al backend", async () => {
    const { get, tool } = setup()
    const out = await run(tool, { cardCode: "P1", modo: "facturas", desde: "2023-01-01", hasta: "2026-09-29" })
    expect(out).toHaveProperty("error.code", "INVALID_PERIOD")
    expect(get).not.toHaveBeenCalled()
  })

  it("solo una fecha → INVALID_PERIOD", async () => {
    const { tool } = setup()
    expect(await run(tool, { cardCode: "P1", modo: "facturas", desde: "2026-01-01" })).toHaveProperty("error.code", "INVALID_PERIOD")
  })

  it("escapa comillas del CardCode en el $filter de notas crédito", async () => {
    const { get, tool } = setup(() => ({ data: [] }))
    await run(tool, { cardCode: "P'1", modo: "facturas", desde: "2026-09-01", hasta: "2026-09-29" })
    const nc = get.mock.calls.map((c) => c[0]).find((u) => u.startsWith("/compras/notas-credito"))!
    expect(new URLSearchParams(nc.slice(nc.indexOf("?") + 1)).get("$filter")).toContain("CardCode eq 'P''1'")
  })

  it("si fallan las notas crédito devuelve facturas con advertencia (fail-soft), no un error", async () => {
    const { tool } = setup((p) => {
      if (p.startsWith("/compras/notas-credito")) throw new BackendError("GET", p, 400, "{}", "rid-nc")
      return { data: [{ docNum: 1, docDate: "20260910", cardCode: "P1", neto: 700 }] }
    })
    const out = await run(tool, { cardCode: "P1", modo: "facturas", desde: "2026-09-01", hasta: "2026-09-29" })
    expect(out.notasCredito).toBeNull()
    expect(out.comprasNetasSinIva).toBe(700)
    expect((out.advertencias as string[]).join(" ")).toMatch(/SOLO facturas/)
  })

  it("avisa si un mes llega al tope de 5000 filas del backend", async () => {
    const rows = Array.from({ length: 5000 }, (_, i) => ({ docNum: i, docDate: "20260905", cardCode: "X", neto: 1 }))
    const { tool } = setup((p) => (p.startsWith("/purchasing/invoices") ? { data: rows } : { data: [] }))
    const out = await run(tool, { cardCode: "P1", modo: "facturas", desde: "2026-09-01", hasta: "2026-09-29" })
    expect((out.advertencias as string[]).join(" ")).toMatch(/tope de 5000/)
  })
})

describe("compras_proveedor — errores vía classifySapError", () => {
  it.each(["resumen", "aging", "pagos", "historial", "facturas"])("modo=%s", async (modo) => {
    const { tool } = setup(() => {
      throw new BackendError("GET", "/x", 404, JSON.stringify({ error: "no existe" }), "rid-1")
    })
    const out = await run(tool, { cardCode: "P1", modo, desde: "2026-09-01", hasta: "2026-09-29" })
    expect(out).toEqual({ error: expect.objectContaining({ requestId: "rid-1" }) })
    expect((out.error as { code: string }).code).toBeTruthy()
  })
})

describe("helpers de fechas", () => {
  it("mesesCalendario cubre meses completos, cruza de año y respeta bisiestos", () => {
    expect(mesesCalendario("2023-12-15", "2024-02-03")).toEqual([
      { from: "2023-12-01", to: "2023-12-31" },
      { from: "2024-01-01", to: "2024-01-31" },
      { from: "2024-02-01", to: "2024-02-29" },
    ])
  })
  it("normDate acepta YYYYMMDD, ISO y timestamp", () => {
    expect(normDate("20260105")).toBe("2026-01-05")
    expect(normDate("2026-01-05")).toBe("2026-01-05")
    expect(normDate("2026-01-05T00:00:00Z")).toBe("2026-01-05")
    expect(normDate(null)).toBe("")
  })
})
