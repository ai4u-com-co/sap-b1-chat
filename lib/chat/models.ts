// ── Registro único de capacidades de modelos ────────────────────────────────
// Fuente de verdad para modelo + effort + thinking + pricing. Lo consume tanto
// el servidor (route.ts) como el cliente (page.tsx), así que este archivo es
// data pura: sin imports de servidor, seguro para el bundle del navegador.
//
// Anclado a la referencia oficial de la API de Claude (jul-2026):
// - effort: low|medium|high|xhigh|max. Sonnet 5 y Opus 5 soportan la escalera
//   completa. Haiku 4.5 NO soporta effort (da error).
// - thinking adaptive: Opus 5/Sonnet 5. Opus 5 piensa por defecto aunque se
//   omita `thinking`; igual mandamos {type:"adaptive"} explícito. Haiku 4.5 no.
// - pricing por 1M tokens (input/output). Sonnet 5 tiene precio introductorio
//   $2/$10 vigente hasta 2026-08-31; aquí se usa el precio estándar $3/$15
//   para que el cost-tracking no quede desactualizado al vencer la promo.

export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max"

export type ThinkingMode = "adaptive" | "none"

export interface ModelCapability {
  /** ID canónico con punto, usado en UI y en el body de la request. */
  id: string
  /** Slug de la API de Anthropic (con guiones). */
  apiSlug: string
  /** Nombre del modelo para mostrar (pill de costo). */
  name: string
  /** Etiqueta corta de la "tier" en el selector. */
  label: string
  description: string
  contextK: number
  pricing: { input: number; output: number } // USD por 1M tokens
  thinking: ThinkingMode
  /** Niveles de effort soportados por este modelo. [] = no soporta effort. */
  efforts: EffortLevel[]
  /** Effort por defecto cuando el modelo soporta effort. */
  defaultEffort?: EffortLevel
}

export const MODELS: Record<string, ModelCapability> = {
  "claude-haiku-4.5": {
    id: "claude-haiku-4.5",
    apiSlug: "claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    label: "Rápido",
    description: "Claude Haiku 4.5 — consultas simples y rápidas, menor costo (predeterminado)",
    contextK: 200,
    pricing: { input: 1.0, output: 5.0 },
    thinking: "none",
    efforts: [],
  },
  "claude-sonnet-5": {
    id: "claude-sonnet-5",
    apiSlug: "claude-sonnet-5",
    name: "Claude Sonnet 5",
    label: "Balanceado",
    description: "Claude Sonnet 5 — ideal para la mayoría de consultas SAP",
    contextK: 1000,
    pricing: { input: 3.0, output: 15.0 },
    thinking: "adaptive",
    efforts: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "medium",
  },
  "claude-opus-5": {
    id: "claude-opus-5",
    apiSlug: "claude-opus-5",
    name: "Claude Opus 5",
    label: "Máxima IA ⚡",
    description: "Claude Opus 5 — análisis complejos y razonamiento profundo. Más costoso.",
    contextK: 1000,
    pricing: { input: 5.0, output: 25.0 },
    thinking: "adaptive",
    efforts: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "high",
  },
}

export const MODEL_LIST: ModelCapability[] = [
  MODELS["claude-haiku-4.5"],
  MODELS["claude-sonnet-5"],
  MODELS["claude-opus-5"],
]

export const DEFAULT_MODEL_ID = "claude-haiku-4.5"

export function getModel(id: string | undefined): ModelCapability {
  return (id && MODELS[id]) || MODELS[DEFAULT_MODEL_ID]
}

/** Labels cortos para el selector de effort en la UI. */
export const EFFORT_LABELS: Record<EffortLevel, string> = {
  low: "Ágil",
  medium: "Media",
  high: "Alta",
  xhigh: "Muy alta",
  max: "Máxima",
}

/** Pista del trade-off de cada nivel (leyenda dinámica). */
export const EFFORT_HINTS: Record<EffortLevel, string> = {
  low: "rápida y económica",
  medium: "equilibrio velocidad/profundidad",
  high: "análisis riguroso · más lento y costoso",
  xhigh: "muy riguroso · tareas complejas",
  max: "máxima profundidad · sin límite de razonamiento",
}

// ── Resolución segura de configuración del provider ──────────────────────────
// Dado lo que pide el cliente, devuelve una config que NUNCA produce un 400:
// - clampea el effort al set válido del modelo (o lo omite si no soporta),
// - deriva el thinking correcto por modelo.
export type ThinkingConfig =
  | { type: "adaptive"; display?: "summarized" | "omitted" }
  | { type: "disabled" }

export interface ResolvedModelConfig {
  model: ModelCapability
  effort?: EffortLevel
  thinking?: ThinkingConfig
}

/** Clampa un effort pedido al set válido del modelo. */
export function resolveEffort(
  model: ModelCapability,
  requested?: string
): EffortLevel | undefined {
  if (model.efforts.length === 0) return undefined
  if (requested && model.efforts.includes(requested as EffortLevel)) {
    return requested as EffortLevel
  }
  return model.defaultEffort
}

export function resolveModelConfig(
  requestedModel: string | undefined,
  requestedEffort?: string
): ResolvedModelConfig {
  const model = getModel(requestedModel)
  const effort = resolveEffort(model, requestedEffort)
  const thinking: ThinkingConfig | undefined =
    model.thinking === "adaptive" ? { type: "adaptive", display: "summarized" } : undefined
  return { model, effort, thinking }
}

export function calculateCostWithCacheForModel(
  model: ModelCapability,
  b: { noCacheTokens: number; cacheReadTokens: number; cacheWriteTokens: number; outputTokens: number }
): { costUsd: number; savingsUsd: number } {
  // 2x, no 1.25x: el único cache_control de este chat (route.ts, bloque system
  // estático + maestros SAP) pide ttl:"1h", y Anthropic cobra el write de un
  // breakpoint de 1h a 2x el precio de input — el 1.25x es la tarifa del TTL
  // de 5 minutos, que este chat no usa. Si algún día se agrega un breakpoint
  // con TTL de 5 min, este multiplicador deja de ser válido para ese tramo.
  const CACHE_WRITE_MULT = 2.0
  const CACHE_READ_MULT = 0.1
  const { input, output } = model.pricing
  const noCacheCost = (b.noCacheTokens / 1_000_000) * input
  const cacheWriteCost = (b.cacheWriteTokens / 1_000_000) * input * CACHE_WRITE_MULT
  const cacheReadCost = (b.cacheReadTokens / 1_000_000) * input * CACHE_READ_MULT
  const outputCost = (b.outputTokens / 1_000_000) * output
  const costUsd = noCacheCost + cacheWriteCost + cacheReadCost + outputCost
  const savingsUsd = (b.cacheReadTokens / 1_000_000) * input * (1 - CACHE_READ_MULT)
  return { costUsd, savingsUsd }
}
