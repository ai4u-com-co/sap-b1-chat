/**
 * Detección de intención para el routing de modelo del chat SAP.
 *
 * Reemplaza la lista `complexReportKeywords` de route.ts, que (auditoría 29-sep):
 * - buscaba subcadenas exactas: "facturamos", "vendimos", "iva", "cuánto" no escalaban
 *   (la consulta de la captura corrió en Haiku y calculó IVA como ÷1.19);
 * - daba falsos positivos ("top" dentro de "laptop"/"stop", "hacer" en casi todo);
 * - miraba solo el último mensaje: "¿eso incluye IVA?" dentro de un hilo de
 *   facturación no escalaba, justo cuando hay que recalcular.
 *
 * Criterio: cualquier pregunta que pida CIFRAS del negocio (montos, totales,
 * comparaciones, impuestos) o que ESCRIBA en SAP necesita el modelo que mejor
 * respeta las reglas del prompt. Se mira el hilo reciente, no solo el último turno.
 */

export type IntentKind = "cifras" | "escritura" | "analisis"

export interface Intent {
  /** Requiere el modelo más preciso (cifras de negocio, escrituras o análisis). */
  needsPrecision: boolean
  kinds: IntentKind[]
  /** Palabras que dispararon cada tipo (para el log y el aviso al usuario). */
  matches: string[]
}

export function normalize(text: string): string {
  return text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
}

// Raíces al INICIO de palabra (\b) para cubrir conjugaciones sin falsos positivos
// por subcadena ("top" ya no matchea "laptop").
const CIFRAS = [
  "factur", "vend", "venta", "compr", "cobr", "pag", "cartera", "deud", "debe", "saldo",
  "iva", "impuest", "retenc", "margen", "rentab", "utilidad", "ganancia", "perdida",
  "costo", "gasto", "ingreso", "egreso", "flujo de caja", "caja", "presupuest",
  "inventari", "stock", "existencia", "valor", "precio", "monto", "total", "promedio",
  "porcentaj", "cuant", "cifra", "kpi", "pareto", "ranking", "top \\d", "mejores", "peores",
  "vencid", "por vencer", "recaudo", "nomina",
]
const ANALISIS = [
  "compar", "evoluc", "crecim", "tendenc", "proyecc", "variacion", "reporte", "informe",
  "analiz", "analisis", "consolidad", "balance", "estado de resultados", "pyg",
  "mensual", "semanal", "trimestr", "anual", "vs\\b", "versus", "año anterior", "mes anterior",
]
const ESCRITURA = [
  "crea", "crear", "genera", "registr", "actualiz", "modific", "cancel", "anul",
  "cierra", "cerrar", "convierte", "convertir", "reponer", "facturar el pedido", "facturar pedido",
]

function compile(stems: string[]): RegExp {
  return new RegExp(`\\b(?:${stems.join("|")})`, "g")
}
const RX: Record<IntentKind, RegExp> = {
  cifras: compile(CIFRAS),
  analisis: compile(ANALISIS),
  escritura: compile(ESCRITURA),
}

/**
 * @param userTexts mensajes del usuario del hilo, en orden cronológico. Se miran
 *   los últimos `lookback` (por defecto 3), para que una repregunta corta herede la
 *   intención del hilo.
 */
export function detectIntent(userTexts: string[], lookback = 3): Intent {
  const recent = userTexts.slice(-lookback).map(normalize).join(" \n ")
  const kinds: IntentKind[] = []
  const matches: string[] = []
  for (const kind of ["cifras", "analisis", "escritura"] as IntentKind[]) {
    const found = recent.match(RX[kind])
    if (found && found.length > 0) {
      kinds.push(kind)
      matches.push(...found.map((m) => m.trim()))
    }
  }
  return { needsPrecision: kinds.length > 0, kinds, matches: [...new Set(matches)].slice(0, 8) }
}
