/**
 * Tools "de negocio" del chat: reutilizan los endpoints YA VERIFICADOS que consume
 * Mission Control (Pulse / Finanzas / Producción) en sap-b1-backend, en vez de
 * que el LLM recalcule cifras con SQL libre o con las tools de PEDIDOS.
 *
 * Por qué existen: la "venta" oficial de Pulse (backend lib/kpis/registry.ts,
 * ventas_mes_actual) es venta NETA sin IVA = SUM(INV1.LineTotal) de facturas OINV
 * − notas crédito ORIN, por TaxDate, CANCELED='N'. Las tools analisis_ventas /
 * tendencia_ventas miden PEDIDOS (ORDR, DocTotal con IVA, por DocDate) y el SQL
 * libre llegó a "quitar el IVA" dividiendo por 1.19 — cifras que no cuadran con
 * Pulse. Estas tools devuelven exactamente lo mismo que ve el usuario en MC.
 *
 * Factory con dependencias inyectadas (get + status + excludedDates + today) para
 * poder testear la URL construida y el manejo de errores sin montar route.ts.
 * Multitenant: `get` ya está atado al tenant del request (BackendClient base
 * /api/v1/{tenant}); aquí no se nombra ningún tenant.
 */
import { tool } from "ai"
import { z } from "zod"
import { classifySapError } from "@/lib/chat/sap-errors"

export interface NegocioToolDeps {
  /** GET relativo a /api/v1/{tenant} — el caller lo envuelve con withSapTimeout. */
  get: <T>(path: string) => Promise<T>
  /** Estado visible de la tool en la UI (data-tool-status). */
  status: (toolCallId: string, text: string) => void
  /**
   * Fechas (YYYY-MM-DD) que el tenant excluye de las estadísticas de venta
   * (saldos iniciales de migración). Mission Control las manda en cada request a
   * estos mismos endpoints (lib/tenants/*.ts → excludedDates); sin ellas las cifras
   * del chat NO cuadran con Pulse.
   */
  excludedDates?: string[]
  /** Hoy en Bogotá (YYYY-MM-DD). Inyectable para tests. */
  today?: () => string
}

// ── Catálogo de KPIs (ids REALES de sap-b1-backend lib/kpis/registry.ts) ─────
// La `definicion` es texto de negocio corto para que el modelo explique QUÉ mide
// la cifra. Mantener alineado con la `description` de cada KPI del registry.
export const KPI_CATALOG = {
  // Ventas
  ventas_mes_actual: { categoria: "ventas", definicion: "Venta neta sin IVA del periodo (lo que Pulse llama 'Facturación'): suma de las líneas de facturas menos notas crédito, por fecha contable (TaxDate), sin documentos anulados." },
  ventas_ytd: { categoria: "ventas", definicion: "Venta neta sin IVA acumulada del año (1 de enero → fin del periodo): facturas menos notas crédito, por fecha contable, sin anuladas. Se compara contra el mismo tramo del año anterior." },
  notas_credito_mes: { categoria: "ventas", definicion: "Total de notas crédito de venta sin IVA del periodo (suma de líneas), por fecha contable, sin anuladas." },
  ventas_hoy: { categoria: "ventas", definicion: "Total facturado hoy (hora Colombia) sin IVA: suma de líneas de facturas con fecha contable de hoy, sin anuladas. No descuenta notas crédito." },
  facturas_emitidas_mes: { categoria: "ventas", definicion: "Cantidad de facturas de venta emitidas en el periodo (por fecha contable, sin anuladas)." },
  ticket_promedio_mes: { categoria: "ventas", definicion: "Valor promedio por factura sin IVA en el periodo: suma de líneas de facturas ÷ número de facturas." },
  lead_time_promedio_dias: { categoria: "ventas", definicion: "Días promedio entre la digitación del pedido de venta y la fecha de su factura (velocidad del ciclo comercial)." },
  entregas_sin_facturar: { categoria: "ventas", definicion: "Valor neto sin IVA de las entregas ya despachadas que aún no se han facturado (foto al día de hoy)." },
  pedidos_abiertos: { categoria: "ventas", definicion: "Número de órdenes de venta abiertas, pendientes de facturar (foto al día de hoy)." },
  backlog_pedidos_valor: { categoria: "ventas", definicion: "Valor pendiente de despachar de los pedidos abiertos: Σ precio × cantidad pendiente por línea (foto al día de hoy)." },
  facturacion_por_vendedor: { categoria: "ventas", definicion: "Número de vendedores con facturas o notas crédito en el periodo. Su detalle trae la venta neta sin IVA por vendedor (facturas − notas crédito)." },
  // Cartera
  cartera_vencida: { categoria: "cartera", definicion: "Saldo por cobrar de facturas ya vencidas a hoy, CON IVA (es lo que el cliente debe pagar): total de la factura − lo ya pagado, solo saldos positivos." },
  cobros_mes: { categoria: "cartera", definicion: "Total cobrado a clientes en el periodo, CON IVA (dinero realmente recibido), sin cobros anulados." },
  rotacion_cartera_dias: { categoria: "cartera", definicion: "Días promedio ponderados entre la fecha de la factura y la fecha en que se cobró, para los pagos recibidos en el periodo." },
  cuentas_por_cobrar: { categoria: "cartera", definicion: "Saldo total por cobrar de todas las facturas abiertas (vencidas y por vencer): total de la factura − lo ya pagado, CON IVA (foto al día de hoy)." },
  // Producción
  ordenes_produccion_abiertas: { categoria: "produccion", definicion: "Órdenes de producción planificadas o liberadas (en proceso) al día de hoy." },
  ops_cerradas_mes: { categoria: "produccion", definicion: "Órdenes de producción completadas en el periodo." },
  ops_cerradas_promedio_diario: { categoria: "produccion", definicion: "Ritmo de cierre del mes en curso: OPs cerradas este mes ÷ días transcurridos del mes (no depende del periodo pedido)." },
  // Clientes
  clientes_nuevos_mes: { categoria: "clientes", definicion: "Clientes cuya primera factura (nunca habían comprado) se emitió en el periodo." },
  valor_clientes_nuevos_mes: { categoria: "clientes", definicion: "Venta neta sin IVA facturada a los clientes nuevos del periodo." },
  clientes_activos_mes: { categoria: "clientes", definicion: "Clientes con al menos una factura en el periodo." },
  // Compras
  ordenes_compra_abiertas: { categoria: "compras", definicion: "Órdenes de compra pendientes de recibir (foto al día de hoy)." },
  gasto_compras_mes: { categoria: "compras", definicion: "Total de facturas de compra sin IVA del periodo (subtotal de líneas, sin retenciones)." },
  pagos_a_proveedores_mes: { categoria: "compras", definicion: "Total pagado a proveedores en el periodo, CON IVA (dinero realmente desembolsado)." },
  facturas_recibidas_mes: { categoria: "compras", definicion: "Cantidad de facturas de proveedor recibidas en el periodo." },
  // Inventario
  valor_inventario: { categoria: "inventario", definicion: "Valor del inventario a costo: Σ existencias × costo promedio (o último costo de compra si el promedio es 0). Foto al día de hoy." },
  dias_rotacion_inventario: { categoria: "inventario", definicion: "Días que tarda el inventario en rotar: valor del inventario ÷ costo de ventas diario de los últimos 90 días. Menor es mejor." },
  inventario_inmovilizado: { categoria: "inventario", definicion: "Valor a costo del inventario con existencias pero sin ventas en los últimos 90 días (capital congelado). Menor es mejor." },
  costo_venta: { categoria: "inventario", definicion: "Costo de lo vendido en el periodo: costo con que SAP valoró la mercancía de las facturas menos la de las notas crédito." },
} as const satisfies Record<string, { categoria: string; definicion: string }>

export type KpiId = keyof typeof KPI_CATALOG
export const KPI_IDS = Object.keys(KPI_CATALOG) as [KpiId, ...KpiId[]]

const DEFINICION_VENTA_NETA =
  "Venta neta sin IVA (misma definición que Pulse): facturas − notas crédito, suma de las líneas (LineTotal), por fecha contable (TaxDate), sin documentos anulados."

const NOTA_UNIDADES_RANKING =
  "total = venta neta sin IVA. pctOfTotal es una fracción 0–1 (×100 para %); trend y grossMarginPct ya vienen en %. trend null = sin periodo anterior comparable."

// ── Helpers ──────────────────────────────────────────────────────────────────

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Formato YYYY-MM-DD")

export function todayBogota(): string {
  // Nunca toISOString(): de noche en Colombia ya es "mañana" en UTC.
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Bogota" })
}

/** Resuelve el periodo: ambos o ninguno. Si ninguno → mes en curso (1 → hoy, Bogotá). */
export function resolvePeriodo(
  desde: string | undefined,
  hasta: string | undefined,
  today: string,
): { desde: string; hasta: string; porDefecto: boolean } | { error: { code: string; message: string; retryable: boolean } } {
  if (desde && hasta) {
    if (desde > hasta) {
      return { error: { code: "INVALID_PERIOD", message: "'desde' es posterior a 'hasta'. Envía un rango válido (YYYY-MM-DD).", retryable: true } }
    }
    return { desde, hasta, porDefecto: false }
  }
  if (desde || hasta) {
    return { error: { code: "INVALID_PERIOD", message: "Envía 'desde' y 'hasta' juntos (YYYY-MM-DD), u omite ambos para usar el mes en curso.", retryable: true } }
  }
  return { desde: `${today.slice(0, 7)}-01`, hasta: today, porDefecto: true }
}

function qs(params: Record<string, string | number | undefined>): string {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
  return parts.length ? `?${parts.join("&")}` : ""
}

/** Los endpoints de capability devuelven `{ data }`; otros el objeto directo. */
function unwrap<T>(res: unknown): T {
  if (res && typeof res === "object" && !Array.isArray(res) && "data" in res) {
    return (res as { data: T }).data
  }
  return res as T
}

function cap<T>(rows: T[], max: number): { filas: T[]; totalFilas: number; truncado: boolean } {
  return { filas: rows.slice(0, max), totalFilas: rows.length, truncado: rows.length > max }
}

type KpiResult = {
  id: string
  name: string
  unit: string
  value: number
  previousValue: number | null
  trend: number | null
  error?: string
}
type KpisResponse = { data?: KpiResult[]; meta?: { periodFrom?: string; periodTo?: string; stale?: boolean; sapDown?: boolean; cachedAt?: string } }
type KpiDetail = { kpiId: string; name: string; columns?: unknown[]; rows?: Record<string, unknown>[] }

type EstadoNodo = { codigo: string; nombre: string; totalAnio: number; montosPorMes?: number[]; hijos?: EstadoNodo[] }

/** Recorta el árbol PUC a clase (1 dígito) + grupo (2 dígitos): el árbol completo es enorme. */
function trimPuc(nodos: EstadoNodo[], depth = 0): EstadoNodo[] {
  return nodos.map((n) => ({
    codigo: n.codigo,
    nombre: n.nombre,
    totalAnio: n.totalAnio,
    montosPorMes: n.montosPorMes,
    ...(depth < 1 && n.hijos?.length ? { hijos: trimPuc(n.hijos, depth + 1) } : {}),
  }))
}

// ── Compras a proveedores ────────────────────────────────────────────────────
// Endpoints REALES de sap-b1-backend (origin/master): suppliers/[cardCode]/{summary,
// aging,history,payments} (lib/capabilities/supplier.ts) y purchasing/invoices
// (lib/capabilities/purchases.ts). Son los mismos que consume Mission Control
// (app/api/finance/supplier/[cardCode] y lib/finance/sap.ts).

export const DEFINICION_COMPRAS: Record<ModoCompras, string> = {
  facturas:
    "Compras netas sin IVA = facturas de proveedor − notas crédito de proveedor, sumando el subtotal de las líneas (LineTotal: antes de IVA y sin retenciones), por fecha de contabilización (DocDate), sin documentos anulados. " +
    "Mismo criterio que el indicador 'Gasto en compras' de Pulse, que suma solo facturas (no resta notas crédito).",
  resumen:
    "Saldo por pagar al proveedor CON IVA (facturas abiertas: total − lo ya pagado, sin anuladas), saldo vencido, órdenes de compra abiertas y la última orden de compra (su total es CON IVA).",
  historial:
    "Artículos más comprados al proveedor en los últimos N meses (facturas de proveedor por DocDate, sin anuladas): el total por artículo es sin IVA (LineTotal). " +
    "El 'totalAmount' general es total de facturas − IVA: queda por debajo del neto si hubo retenciones y NO resta notas crédito — para el total comprado usa modo='facturas'.",
  pagos:
    "Pagos hechos al proveedor (pagos efectuados), CON IVA: dinero realmente desembolsado. totalPaid suma efectivo + transferencias de los pagos no anulados (no incluye cheques ni tarjeta). La lista trae los últimos pagos, incluidos los anulados (cancelled=true).",
  aging:
    "Antigüedad de lo que se le debe al proveedor, CON IVA: saldo pendiente (total − pagado) de sus facturas abiertas sin anular, por tramos de días de vencimiento, con el detalle por factura.",
}

export type ModoCompras = "resumen" | "historial" | "pagos" | "aging" | "facturas"

type PurchaseInvoiceRow = { docNum: number; docDate: string; cardCode: string; cardName?: string; neto: number }
type CreditNoteRow = { DocEntry?: number; DocNum?: number; DocDate?: string; Cancelled?: string; DocumentLines?: { LineTotal?: number }[] }

const MAX_MESES_FACTURAS = 24
/** Tope de filas de purchasing/invoices (lib/capabilities/purchases.ts: sapQuery(..., 5000)). */
const TOPE_FACTURAS_BACKEND = 5000
/** Tope de $top del handler OData genérico del gateway (lib/sap/handler.ts). */
const TOPE_NOTAS_CREDITO = 500
const CONCURRENCIA_MESES = 3

/** "20260105" | "2026-01-05" | "2026-01-05T00:00:00Z" → "2026-01-05". */
export function normDate(d: unknown): string {
  const digits = String(d ?? "").replace(/\D/g, "").slice(0, 8)
  return digits.length === 8 ? `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}` : ""
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/**
 * Meses calendario completos que cubren [desde, hasta], con el MISMO formato de
 * rango que usa Mission Control (lib/finance/sap.ts): YYYY-MM-01 → último día.
 * Así la clave de caché del backend (`${tenant}:purchasing-invoices:${from}:${to}`)
 * coincide con la de Finanzas y un mes ya consultado por MC sale de caché.
 */
export function mesesCalendario(desde: string, hasta: string): { from: string; to: string }[] {
  const out: { from: string; to: string }[] = []
  let y = Number(desde.slice(0, 4))
  let m = Number(desde.slice(5, 7))
  const yEnd = Number(hasta.slice(0, 4))
  const mEnd = Number(hasta.slice(5, 7))
  while (y < yEnd || (y === yEnd && m <= mEnd)) {
    const mm = String(m).padStart(2, "0")
    out.push({ from: `${y}-${mm}-01`, to: `${y}-${mm}-${String(lastDayOfMonth(y, m)).padStart(2, "0")}` })
    m++
    if (m > 12) { m = 1; y++ }
  }
  return out
}

async function inBatches<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.all(items.slice(i, i + size).map(fn))))
  }
  return out
}

const round2 = (n: number) => Math.round(n * 100) / 100

// ── Factory ──────────────────────────────────────────────────────────────────

export function createNegocioTools(deps: NegocioToolDeps) {
  const today = deps.today ?? todayBogota
  const excluded = deps.excludedDates?.length ? deps.excludedDates.join(",") : undefined

  return {
    kpi_negocio: tool({
      description:
        "FUENTE OFICIAL para cualquier pregunta de cuánto vendimos/facturamos (y demás indicadores del tablero); mismas cifras que Pulse en Mission Control. " +
        "Úsala ANTES que analisis_ventas, el catálogo o consultar_sql para ventas, facturación, notas crédito, ticket promedio, cartera, cobros, compras, inventario y producción agregados. " +
        "ventas_mes_actual = venta neta sin IVA del periodo pedido (no solo del mes actual si envías desde/hasta). " +
        "Sin desde/hasta usa el mes en curso (igual que Pulse). detalle=true trae el desglose (por cliente, factura, vendedor, etc.). " +
        "Devuelve 'definicion': explícasela al usuario con la cifra.",
      inputSchema: z.object({
        kpiId: z.enum(KPI_IDS).describe("Id del indicador"),
        desde: isoDate.optional().describe("Inicio del periodo YYYY-MM-DD (junto con 'hasta')"),
        hasta: isoDate.optional().describe("Fin del periodo YYYY-MM-DD (junto con 'desde')"),
        compararAnioAnterior: z.boolean().optional().describe("true = la variación se calcula contra las mismas fechas del año anterior en vez del periodo inmediatamente anterior"),
        detalle: z.boolean().optional().describe("true = incluye el desglose del indicador (hasta 50 filas)"),
      }),
      execute: async (
        { kpiId, desde, hasta, compararAnioAnterior, detalle }:
        { kpiId: KpiId; desde?: string; hasta?: string; compararAnioAnterior?: boolean; detalle?: boolean },
        { toolCallId },
      ) => {
        const def = KPI_CATALOG[kpiId]
        if (!def) {
          return { error: { code: "INVALID_KPI", message: `KPI '${kpiId}' no existe. Válidos: ${KPI_IDS.join(", ")}`, retryable: false } }
        }
        if ((desde && !hasta) || (!desde && hasta)) {
          return { error: { code: "INVALID_PERIOD", message: "Envía 'desde' y 'hasta' juntos (YYYY-MM-DD), u omite ambos para usar el mes en curso.", retryable: true } }
        }
        deps.status(toolCallId, `Consultando indicador ${kpiId}…`)
        try {
          // Sin `category` a propósito: la clave de caché del backend incluye la
          // categoría, así que la misma consulta que hace Pulse (sin categoría)
          // reutiliza su caché SWR y devuelve exactamente la misma cifra.
          const path = `/kpis${qs({ from: desde, to: hasta, compare: compararAnioAnterior ? "yoy" : undefined, excludedDates: excluded })}`
          const res = await deps.get<KpisResponse>(path)
          const kpi = res.data?.find((k) => k.id === kpiId)
          if (!kpi) {
            return { error: { code: "KPI_NOT_RETURNED", message: `El backend no devolvió el indicador '${kpiId}'. No lo reemplaces con SQL; informa al usuario.`, retryable: false } }
          }
          const periodo = { desde: res.meta?.periodFrom ?? desde, hasta: res.meta?.periodTo ?? hasta, porDefecto: !desde }
          const out: Record<string, unknown> = {
            kpi: {
              id: kpi.id,
              nombre: kpi.name,
              unidad: kpi.unit,
              valor: kpi.value,
              valorPeriodoAnterior: kpi.previousValue,
              variacionPct: kpi.trend,
              ...(kpi.error ? { error: kpi.error } : {}),
            },
            periodo,
            definicion: def.definicion,
            fuente: "Pulse (sap-b1-backend /kpis) — mismas cifras que el tablero de Mission Control",
            ...(res.meta?.stale ? { nota: `Dato servido desde caché del tablero (generado ${res.meta.cachedAt ?? "hace unos minutos"}).` } : {}),
            ...(res.meta?.sapDown ? { advertencia: "SAP no estaba disponible; la cifra puede venir de caché o estar incompleta." } : {}),
          }
          if (kpi.error) {
            out.advertencia = "El backend reportó error calculando este indicador (valor 0 no es real). Dile al usuario que no está disponible ahora; no lo reemplaces con SQL."
          }
          if (detalle) {
            deps.status(toolCallId, `Cargando desglose de ${kpiId}…`)
            // Mismo periodo que devolvió la tarjeta (meta.periodFrom/To, ya en
            // hora Bogotá): el route de detalle calcula su default con la hora
            // del servidor (UTC), que de noche puede caer en otro mes.
            const detailPath = `/kpis/${encodeURIComponent(kpiId)}/detail${qs({ from: periodo.desde, to: periodo.hasta, excludedDates: excluded })}`
            const det = await deps.get<KpiDetail>(detailPath)
            const rows = Array.isArray(det.rows) ? det.rows : []
            out.detalle = { columnas: det.columns ?? [], ...cap(rows, 50) }
          }
          return out
        } catch (err) {
          return classifySapError(err)
        }
      },
    }),

    tendencia_facturacion: tool({
      description:
        "Venta neta sin IVA mes a mes del año anterior y del año en curso (24 meses; misma serie que el gráfico de tendencia de Pulse). " +
        "Preferir sobre tendencia_ventas (que mide PEDIDOS) para 'ventas por mes', 'cómo vamos vs el año pasado', crecimiento mensual/anual. " +
        "Los meses futuros del año en curso vienen en 0.",
      inputSchema: z.object({}),
      execute: async (_args: Record<string, never>, { toolCallId }) => {
        deps.status(toolCallId, "Calculando tendencia de facturación…")
        try {
          const res = await deps.get<{ salesTrend?: { year: number; month: number; total: number }[] }>(
            `/kpis/sales-trend${qs({ excludedDates: excluded })}`,
          )
          const serie = unwrap<{ salesTrend?: { year: number; month: number; total: number }[] }>(res)?.salesTrend ?? []
          return { serie, definicion: DEFINICION_VENTA_NETA }
        } catch (err) {
          return classifySapError(err)
        }
      },
    }),

    top_clientes: tool({
      description:
        "Ranking de clientes por venta neta sin IVA (facturas − notas crédito, misma definición que Pulse) con participación %, utilidad bruta, margen % y variación vs el periodo anterior. " +
        "Preferir sobre analisis_ventas (que mide pedidos) y sobre el catálogo/SQL para 'mejores clientes', 'a quién le vendimos más', 'margen por cliente'.",
      inputSchema: z.object({
        desde: isoDate.optional(),
        hasta: isoDate.optional(),
        limite: z.number().int().min(1).max(100).optional().describe("Cantidad de clientes (default 10)"),
      }),
      execute: async ({ desde, hasta, limite }: { desde?: string; hasta?: string; limite?: number }, { toolCallId }) => {
        const p = resolvePeriodo(desde, hasta, today())
        if ("error" in p) return p
        deps.status(toolCallId, "Calculando ranking de clientes…")
        try {
          const res = await deps.get<unknown>(`/insights/top-customers${qs({ from: p.desde, to: p.hasta, limit: limite ?? 10, excludedDates: excluded })}`)
          return { clientes: unwrap<unknown[]>(res), periodo: p, definicion: DEFINICION_VENTA_NETA, nota: NOTA_UNIDADES_RANKING }
        } catch (err) {
          return classifySapError(err)
        }
      },
    }),

    ventas_cliente_mensual: tool({
      description:
        "Venta neta sin IVA y utilidad bruta por cliente y por mes (facturas − notas crédito, misma definición que Pulse). " +
        "Para tendencia mensual de uno o varios clientes. Con cardCode filtra a ese cliente; sin él devuelve los clientes de mayor venta del periodo.",
      inputSchema: z.object({
        desde: isoDate.optional(),
        hasta: isoDate.optional(),
        cardCode: z.string().optional().describe("CardCode exacto del cliente (opcional)"),
        topClientes: z.number().int().min(1).max(50).optional().describe("Si no hay cardCode: cuántos clientes incluir (default 15)"),
      }),
      execute: async (
        { desde, hasta, cardCode, topClientes }: { desde?: string; hasta?: string; cardCode?: string; topClientes?: number },
        { toolCallId },
      ) => {
        const p = resolvePeriodo(desde, hasta, today())
        if ("error" in p) return p
        deps.status(toolCallId, "Calculando ventas por cliente y mes…")
        try {
          const res = await deps.get<unknown>(`/insights/sales-by-customer-monthly${qs({ from: p.desde, to: p.hasta, excludedDates: excluded })}`)
          type Cell = { mes: string; cardCode: string; cardName?: string; total: number; grossProfit?: number; grossMarginPct?: number | null }
          const cells = unwrap<Cell[]>(res)
          const all = Array.isArray(cells) ? cells : []
          let selected: Cell[]
          if (cardCode) {
            selected = all.filter((c) => c.cardCode === cardCode)
          } else {
            const totals = new Map<string, number>()
            for (const c of all) totals.set(c.cardCode, (totals.get(c.cardCode) ?? 0) + (Number(c.total) || 0))
            const top = new Set([...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, topClientes ?? 15).map(([k]) => k))
            selected = all.filter((c) => top.has(c.cardCode))
          }
          selected.sort((a, b) => a.cardCode.localeCompare(b.cardCode) || a.mes.localeCompare(b.mes))
          return {
            celdas: selected,
            clientesEnPeriodo: new Set(all.map((c) => c.cardCode)).size,
            periodo: p,
            definicion: DEFINICION_VENTA_NETA,
          }
        } catch (err) {
          return classifySapError(err)
        }
      },
    }),

    ventas_por_vendedor: tool({
      description:
        "Venta neta sin IVA por vendedor (misma definición que Pulse). " +
        "modo='ranking': top vendedores del periodo con % y variación. " +
        "modo='presupuesto': cumplimiento vs presupuesto y crecimiento vs año anterior, mes a mes, del año indicado (si el tenant no tiene presupuesto, hasBudget=false).",
      inputSchema: z.object({
        modo: z.enum(["ranking", "presupuesto"]),
        desde: isoDate.optional().describe("Solo modo ranking"),
        hasta: isoDate.optional().describe("Solo modo ranking"),
        limite: z.number().int().min(1).max(20).optional().describe("Solo modo ranking (default 10)"),
        anio: z.number().int().min(2000).max(2100).optional().describe("Solo modo presupuesto (default año en curso)"),
      }),
      execute: async (
        { modo, desde, hasta, limite, anio }:
        { modo: "ranking" | "presupuesto"; desde?: string; hasta?: string; limite?: number; anio?: number },
        { toolCallId },
      ) => {
        try {
          if (modo === "presupuesto") {
            const year = anio ?? Number(today().slice(0, 4))
            deps.status(toolCallId, `Calculando ventas vs presupuesto ${year}…`)
            const res = await deps.get<unknown>(`/insights/sales-vs-budget${qs({ year, excludedDates: excluded })}`)
            return { presupuesto: unwrap<unknown>(res), anio: year, definicion: DEFINICION_VENTA_NETA }
          }
          const p = resolvePeriodo(desde, hasta, today())
          if ("error" in p) return p
          deps.status(toolCallId, "Calculando ranking de vendedores…")
          const res = await deps.get<unknown>(`/insights/top-salespeople${qs({ from: p.desde, to: p.hasta, limit: limite ?? 10, excludedDates: excluded })}`)
          return { vendedores: unwrap<unknown[]>(res), periodo: p, definicion: DEFINICION_VENTA_NETA, nota: NOTA_UNIDADES_RANKING }
        } catch (err) {
          return classifySapError(err)
        }
      },
    }),

    cartera_deudores: tool({
      description:
        "Cartera de clientes (montos CON IVA: es lo que el cliente debe pagar, no es inconsistencia con la venta sin IVA). " +
        "modo='mayores_deudores': clientes con mayor saldo vencido y su % del total. " +
        "modo='por_vencer': facturas que vencen en los próximos 7/15/30 días (cantidad y monto). " +
        "Para aging completo por tramos usa cartera_empresa; para un cliente puntual, aging_cliente.",
      inputSchema: z.object({
        modo: z.enum(["mayores_deudores", "por_vencer"]),
        limite: z.number().int().min(1).max(20).optional().describe("Solo mayores_deudores (default 10)"),
      }),
      execute: async ({ modo, limite }: { modo: "mayores_deudores" | "por_vencer"; limite?: number }, { toolCallId }) => {
        try {
          if (modo === "por_vencer") {
            deps.status(toolCallId, "Consultando cartera por vencer…")
            const res = await deps.get<unknown>("/receivables/upcoming")
            return {
              porVencer: unwrap<unknown[]>(res),
              nota: "Montos con IVA (saldo por cobrar). Tramos excluyentes: bucket 7 = vence en 0–7 días, 15 = 8–15 días, 30 = 16–30 días (no son acumulados).",
            }
          }
          deps.status(toolCallId, "Consultando mayores deudores…")
          const res = await deps.get<unknown>(`/receivables/top-debtors${qs({ limit: limite ?? 10 })}`)
          return {
            deudores: unwrap<unknown[]>(res),
            nota: "Montos con IVA (saldo vencido por cobrar). pctOfTotal es una fracción 0–1 (multiplica por 100 para %). Para el total oficial de cartera vencida usa kpi_negocio(cartera_vencida).",
          }
        } catch (err) {
          return classifySapError(err)
        }
      },
    }),

    estado_resultados: tool({
      description:
        "Estado de resultados contable (desde los asientos, no desde facturas). " +
        "modo='pyg': P&G del periodo — ingresos, costos, gastos, utilidad bruta/operacional/neta, EBITDA, márgenes, mes a mes y principales cuentas de gasto (es el que usa Finanzas en Mission Control). " +
        "modo='indicadores': márgenes YTD, ROE, ROIC, balance resumido y ciclo de conversión de caja. " +
        "modo='anual_puc': estado de resultados del año por cuenta PUC (clase y grupo), mes a mes.",
      inputSchema: z.object({
        modo: z.enum(["pyg", "indicadores", "anual_puc"]),
        desde: isoDate.optional().describe("Solo pyg"),
        hasta: isoDate.optional().describe("Solo pyg"),
        anio: z.number().int().min(2000).max(2100).optional().describe("Solo anual_puc (default año en curso)"),
      }),
      execute: async (
        { modo, desde, hasta, anio }: { modo: "pyg" | "indicadores" | "anual_puc"; desde?: string; hasta?: string; anio?: number },
        { toolCallId },
      ) => {
        try {
          if (modo === "indicadores") {
            deps.status(toolCallId, "Calculando indicadores financieros…")
            const res = await deps.get<unknown>(`/finance/ratios${qs({ excludedDates: excluded })}`)
            return { indicadores: unwrap<unknown>(res) }
          }
          if (modo === "anual_puc") {
            const year = anio ?? Number(today().slice(0, 4))
            deps.status(toolCallId, `Armando estado de resultados ${year}…`)
            const res = unwrap<{ year?: number; monthsIncluded?: number; raices?: EstadoNodo[]; asOf?: string }>(
              await deps.get<unknown>(`/finance/estado-resultados${qs({ year, excludedDates: excluded })}`),
            )
            return {
              anio: res.year ?? year,
              mesesIncluidos: res.monthsIncluded,
              cuentas: trimPuc(res.raices ?? []),
              nota: "Recortado a clase y grupo PUC (2 dígitos). Para cuentas auxiliares, la vista Estado de Resultados de Mission Control tiene el árbol completo.",
            }
          }
          const p = resolvePeriodo(desde, hasta, today())
          if ("error" in p) return p
          deps.status(toolCallId, "Calculando estado de resultados…")
          const res = unwrap<Record<string, unknown>>(
            await deps.get<unknown>(`/finance/pnl${qs({ from: p.desde, to: p.hasta, excludedDates: excluded })}`),
          )
          // childCodes (Set serializado) y creditByMonth son internos del panel de MC.
          const pyg = { ...(res ?? {}) }
          delete pyg.childCodes
          delete pyg.creditByMonth
          return { pyg, periodo: p }
        } catch (err) {
          return classifySapError(err)
        }
      },
    }),

    produccion_indicadores: tool({
      description:
        "Indicadores de producción de Mission Control. " +
        "modo='resumen': OPs abiertas/cerradas, metros y valor pendientes/cerrados, ritmo diario y cola estimada (con split con/sin impresión). " +
        "modo='variacion': informe de variación por OP (costo y tiempo planificado vs real, GANANCIA/PÉRDIDA). " +
        "modo='cumplimiento_entregas': % de OPs entregadas a tiempo vs la política por tecnología y por comercial. " +
        "Sin desde/hasta usa el mes en curso.",
      inputSchema: z.object({
        modo: z.enum(["resumen", "variacion", "cumplimiento_entregas"]),
        desde: isoDate.optional(),
        hasta: isoDate.optional(),
      }),
      execute: async (
        { modo, desde, hasta }: { modo: "resumen" | "variacion" | "cumplimiento_entregas"; desde?: string; hasta?: string },
        { toolCallId },
      ) => {
        const p = resolvePeriodo(desde, hasta, today())
        if ("error" in p) return p
        try {
          if (modo === "resumen") {
            deps.status(toolCallId, "Calculando indicadores de producción…")
            const d = unwrap<Record<string, unknown> & { days?: unknown[]; cerradas?: unknown[] }>(
              await deps.get<unknown>(`/insights/production-kpis${qs({ from: p.desde, to: p.hasta })}`),
            )
            const { cerradas, days, ...rest } = d ?? {}
            return {
              ...rest,
              dias: Array.isArray(days) ? days.slice(-31) : [],
              opsCerradas: cap(Array.isArray(cerradas) ? cerradas : [], 20),
              periodo: p,
            }
          }
          if (modo === "variacion") {
            deps.status(toolCallId, "Calculando variación de producción…")
            type Row = { deviationTotal?: number | null; status?: string | null }
            const d = unwrap<{ rows?: Row[]; costTruncated?: boolean; metrosDisponible?: boolean; costTimeEnabled?: boolean; asOf?: string }>(
              await deps.get<unknown>(`/production/variance${qs({ from: p.desde, to: p.hasta })}`),
            )
            const rows = Array.isArray(d?.rows) ? d.rows : []
            const ganancia = rows.filter((r) => r.status === "GANANCIA").length
            const perdida = rows.filter((r) => r.status === "PERDIDA").length
            const desviacionTotal = rows.reduce((s, r) => s + (Number(r.deviationTotal) || 0), 0)
            const ordenadas = [...rows].sort((a, b) => Math.abs(Number(b.deviationTotal) || 0) - Math.abs(Number(a.deviationTotal) || 0))
            return {
              resumen: { ops: rows.length, ganancia, perdida, desviacionTotal },
              mayoresDesviaciones: cap(ordenadas, 20),
              costosTruncados: d?.costTruncated ?? false,
              metrosDisponible: d?.metrosDisponible,
              periodo: p,
            }
          }
          deps.status(toolCallId, "Calculando cumplimiento de entregas…")
          type CRow = { estado?: string }
          const d = unwrap<Record<string, unknown> & { rows?: CRow[] }>(
            await deps.get<unknown>(`/insights/delivery-compliance${qs({ from: p.desde, to: p.hasta })}`),
          )
          const { rows, ...rest } = d ?? {}
          const tarde = (Array.isArray(rows) ? rows : []).filter((r) => r.estado === "tarde" || r.estado === "vencida_en_curso")
          return { ...rest, opsTardeOVencidas: cap(tarde, 20), periodo: p }
        } catch (err) {
          return classifySapError(err)
        }
      },
    }),

    compras_proveedor: tool({
      description:
        "FUENTE para cifras de COMPRAS a un proveedor (cuánto le compramos, cuánto le debemos, qué le compramos, cuánto le pagamos). Requiere el CardCode exacto (búscalo antes con buscar_socio_o_item). " +
        "modo='facturas': compras netas SIN IVA del periodo (facturas − notas crédito de proveedor, sin anuladas) con desglose por mes y mayores facturas — úsalo para '¿cuánto le hemos comprado/nos ha facturado?'. Sin desde/hasta usa el año en curso; máximo 24 meses por consulta. " +
        "modo='resumen': saldo por pagar y vencido (CON IVA), órdenes de compra abiertas y última OC. " +
        "modo='aging': lo que se le debe por tramos de vencimiento (CON IVA), factura por factura. " +
        "modo='pagos': pagos hechos al proveedor (CON IVA). " +
        "modo='historial': artículos más comprados en los últimos N meses. " +
        "Para cuentas por pagar de TODA la empresa usa cartera_empresa(cuentas_por_pagar); para el gasto total en compras del mes, kpi_negocio(gasto_compras_mes). " +
        "Devuelve 'definicion': explícasela al usuario con la cifra (con o sin IVA).",
      inputSchema: z.object({
        cardCode: z.string().min(1).describe("CardCode exacto del proveedor"),
        modo: z.enum(["facturas", "resumen", "aging", "pagos", "historial"]),
        desde: isoDate.optional().describe("Solo modo facturas: inicio YYYY-MM-DD (junto con 'hasta')"),
        hasta: isoDate.optional().describe("Solo modo facturas: fin YYYY-MM-DD (junto con 'desde')"),
        meses: z.number().int().min(1).max(36).optional().describe("Solo modo historial (default 12)"),
        topN: z.number().int().min(1).max(50).optional().describe("Solo modo historial: cuántos artículos (default 10)"),
        limite: z.number().int().min(1).max(200).optional().describe("Solo modo pagos: cuántos pagos listar (default 50)"),
      }),
      execute: async (
        { cardCode, modo, desde, hasta, meses, topN, limite }:
        { cardCode: string; modo: ModoCompras; desde?: string; hasta?: string; meses?: number; topN?: number; limite?: number },
        { toolCallId },
      ) => {
        const cc = cardCode.trim()
        const base = `/suppliers/${encodeURIComponent(cc)}`
        const definicion = DEFINICION_COMPRAS[modo]
        try {
          if (modo === "resumen") {
            deps.status(toolCallId, `Consultando resumen del proveedor ${cc}…`)
            return { resumen: unwrap<unknown>(await deps.get<unknown>(`${base}/summary`)), definicion }
          }
          if (modo === "aging") {
            deps.status(toolCallId, `Consultando antigüedad de saldos con ${cc}…`)
            return { aging: unwrap<unknown>(await deps.get<unknown>(`${base}/aging`)), definicion }
          }
          if (modo === "pagos") {
            deps.status(toolCallId, `Consultando pagos a ${cc}…`)
            return { pagos: unwrap<unknown>(await deps.get<unknown>(`${base}/payments${qs({ limit: limite ?? 50 })}`)), definicion }
          }
          if (modo === "historial") {
            const m = meses ?? 12
            deps.status(toolCallId, `Analizando compras a ${cc}…`)
            return {
              historial: unwrap<unknown>(await deps.get<unknown>(`${base}/history${qs({ months: m, topN: topN ?? 10 })}`)),
              meses: m,
              definicion,
            }
          }

          // modo === "facturas"
          let p: { desde: string; hasta: string; porDefecto: boolean }
          if (!desde && !hasta) {
            const hoy = today()
            p = { desde: `${hoy.slice(0, 4)}-01-01`, hasta: hoy, porDefecto: true }
          } else {
            const r = resolvePeriodo(desde, hasta, today())
            if ("error" in r) return r
            p = r
          }
          const mesesRango = mesesCalendario(p.desde, p.hasta)
          if (mesesRango.length > MAX_MESES_FACTURAS) {
            return { error: { code: "INVALID_PERIOD", message: `El periodo abarca ${mesesRango.length} meses; el máximo es ${MAX_MESES_FACTURAS}. Divide la consulta en tramos (por ejemplo, año por año) y suma los resultados.`, retryable: true } }
          }
          deps.status(toolCallId, `Sumando compras a ${cc} (${mesesRango.length} ${mesesRango.length === 1 ? "mes" : "meses"})…`)
          const excludedSet = new Set(deps.excludedDates ?? [])
          const advertencias: string[] = []

          // 1) Facturas de proveedor: el backend no filtra por proveedor → mes a mes y filtro aquí.
          const porMesRaw = await inBatches(mesesRango, CONCURRENCIA_MESES, async (mes) => {
            const res = await deps.get<unknown>(`/purchasing/invoices${qs({ from: mes.from, to: mes.to })}`)
            const rows = unwrap<PurchaseInvoiceRow[]>(res)
            return { mes, rows: Array.isArray(rows) ? rows : [] }
          })
          const vistos = new Set<string>()
          const facturas: { docNum: number; fecha: string; neto: number }[] = []
          let excluidasPorFecha = 0
          let cardName: string | undefined
          for (const { mes, rows } of porMesRaw) {
            if (rows.length >= TOPE_FACTURAS_BACKEND) {
              advertencias.push(`El mes ${mes.from.slice(0, 7)} llegó al tope de ${TOPE_FACTURAS_BACKEND} facturas del backend: el total de ese mes puede estar incompleto.`)
            }
            for (const r of rows) {
              if (r.cardCode !== cc) continue
              const fecha = normDate(r.docDate)
              if (!fecha || fecha < p.desde || fecha > p.hasta) continue
              if (excludedSet.has(fecha)) { excluidasPorFecha++; continue }
              // Versiones viejas del backend repetían cada factura por línea (ver MC lib/finance/sap.ts).
              const key = `${r.docNum}|${fecha}`
              if (vistos.has(key)) continue
              vistos.add(key)
              cardName ??= r.cardName
              facturas.push({ docNum: r.docNum, fecha, neto: Number(r.neto) || 0 })
            }
          }
          if (excluidasPorFecha > 0) {
            advertencias.push(`Se excluyeron ${excluidasPorFecha} factura(s) de fechas que la empresa marca como saldos iniciales de migración (${[...excludedSet].join(", ")}), igual que Mission Control.`)
          }
          const totalFacturas = facturas.reduce((s, f) => s + f.neto, 0)
          type CeldaMes = { mes: string; facturas: number; cantidad: number; notasCredito?: number }
          const porMes = new Map<string, CeldaMes>()
          for (const f of facturas) {
            const k = f.fecha.slice(0, 7)
            const cell = porMes.get(k) ?? { mes: k, facturas: 0, cantidad: 0 }
            cell.facturas += f.neto
            cell.cantidad++
            porMes.set(k, cell)
          }

          // 2) Notas crédito de proveedor (ORPC vía /compras/notas-credito → PurchaseCreditNotes).
          //    Fail-soft: si fallan, se devuelve el total de facturas con una advertencia explícita.
          let notasCredito: { cantidad: number; totalSinIva: number } | null = null
          try {
            const filter = `CardCode eq '${cc.replace(/'/g, "''")}' and DocDate ge '${p.desde}' and DocDate le '${p.hasta}'`
            const ncRes = await deps.get<unknown>(
              `/compras/notas-credito${qs({ $filter: filter, $select: "DocEntry,DocNum,DocDate,Cancelled,DocumentLines", $top: TOPE_NOTAS_CREDITO })}`,
            )
            const ncRows = unwrap<CreditNoteRow[]>(ncRes)
            const rows = Array.isArray(ncRows) ? ncRows : []
            if (rows.length >= TOPE_NOTAS_CREDITO) {
              advertencias.push(`Llegó al tope de ${TOPE_NOTAS_CREDITO} notas crédito: el descuento por notas crédito puede estar incompleto.`)
            }
            // Cancelled='tYES' = NC anulada. Límite conocido (sin verificar en vivo): el documento
            // de cancelación (CANCELED='C' en SQL) podría venir como 'tNO' por OData; es raro en
            // notas crédito de proveedor y no se pudo contrastar contra $metadata de los tenants.
            const validas = rows.filter((nc) => nc.Cancelled !== "tYES" && !excludedSet.has(normDate(nc.DocDate)))
            let totalNc = 0
            for (const nc of validas) {
              const neto = (nc.DocumentLines ?? []).reduce((s, l) => s + (Number(l.LineTotal) || 0), 0)
              totalNc += neto
              const k = normDate(nc.DocDate).slice(0, 7)
              if (k) {
                const cell: CeldaMes = porMes.get(k) ?? { mes: k, facturas: 0, cantidad: 0 }
                cell.notasCredito = (cell.notasCredito ?? 0) + neto
                porMes.set(k, cell)
              }
            }
            notasCredito = { cantidad: validas.length, totalSinIva: round2(totalNc) }
          } catch {
            advertencias.push("No se pudieron consultar las notas crédito del proveedor: la cifra es SOLO facturas (no descuenta notas crédito). Dilo al usuario.")
          }

          const mayores = [...facturas].sort((a, b) => b.neto - a.neto)
          return {
            proveedor: { cardCode: cc, ...(cardName ? { cardName } : {}) },
            periodo: p,
            facturas: { cantidad: facturas.length, totalSinIva: round2(totalFacturas), mayores: cap(mayores, 10) },
            notasCredito,
            comprasNetasSinIva: round2(totalFacturas - (notasCredito?.totalSinIva ?? 0)),
            porMes: [...porMes.values()]
              .sort((a, b) => a.mes.localeCompare(b.mes))
              .map((c) => ({ ...c, facturas: round2(c.facturas), ...(c.notasCredito !== undefined ? { notasCredito: round2(c.notasCredito) } : {}) })),
            definicion,
            ...(advertencias.length ? { advertencias } : {}),
          }
        } catch (err) {
          return classifySapError(err)
        }
      },
    }),
  }
}
