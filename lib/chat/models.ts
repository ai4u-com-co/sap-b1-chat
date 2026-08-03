// ── Registro único de capacidades de modelos ────────────────────────────────
// Fuente de verdad para modelo + effort + thinking + pricing. Lo consume tanto
// el servidor (route.ts) como el cliente (page.tsx), así que este archivo es
// data pura: sin imports de servidor, seguro para el bundle del navegador.
//
// Anclado a la referencia oficial de la API de Claude (jun-2026):
// - effort: low|medium|high|xhigh|max. xhigh solo Opus 4.7+/Fable; max Fable/
//   Opus 4.6+/Sonnet 4.6. Haiku 4.5 NO soporta effort (da error).
// - thinking adaptive: Fable/Opus 4.8/4.7/4.6/Sonnet 4.6. Haiku 4.5 no.
// - pricing por 1M tokens (input/output).
//
// gatewaySlug: verificado contra el catálogo real de Vercel AI Gateway
// (GET https://ai-gateway.vercel.sh/v1/models, público, sin auth) el
// 2026-07-30 — NO se derivó por heurística de apiSlug (guion→punto no es
// consistente: Haiku usa punto "4.5" pero el apiSlug de Anthropic usa guion
// "4-5"; modelos sin minor version como Sonnet/Opus "5" no llevan punto).
// Si se agrega un modelo nuevo, volver a verificar contra ese endpoint antes
// de inventar el slug — un slug mal formado devuelve 400 y rompe el chat.

export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max"

export type ThinkingMode = "adaptive" | "none"

export interface ModelCapability {
  /** ID canónico con punto, usado en UI y en el body de la request. */
  id: string
  /** Slug de la API de Anthropic (con guiones). */
  apiSlug: string
  /** Slug de Vercel AI Gateway ("anthropic/<id>") — ver nota arriba. */
  gatewaySlug: string
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
    gatewaySlug: "anthropic/claude-haiku-4.5",
    name: "Claude Haiku 4.5",
    label: "Rápido",
    description: "Claude Haiku 4.5 — consultas simples y rápidas, menor costo (predeterminado)",
    contextK: 200,
    pricing: { input: 1.0, output: 5.0 },
    thinking: "none",
    efforts: [],
  },
  "claude-sonnet-4.6": {
    id: "claude-sonnet-4.6",
    apiSlug: "claude-sonnet-4-6",
    gatewaySlug: "anthropic/claude-sonnet-4.6",
    name: "Claude Sonnet 4.6",
    label: "Balanceado",
    description: "Claude Sonnet 4.6 — ideal para la mayoría de consultas SAP",
    contextK: 1000,
    pricing: { input: 3.0, output: 15.0 },
    thinking: "adaptive",
    efforts: ["low", "medium", "high", "max"],
    defaultEffort: "medium",
  },
  "claude-opus-4.8": {
    id: "claude-opus-4.8",
    apiSlug: "claude-opus-4-8",
    gatewaySlug: "anthropic/claude-opus-4.8",
    name: "Claude Opus 4.8",
    label: "Máxima IA ⚡",
    description: "Claude Opus 4.8 — análisis complejos y razonamiento profundo. Más costoso.",
    contextK: 1000,
    pricing: { input: 5.0, output: 25.0 },
    thinking: "adaptive",
    efforts: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "high",
  },
}

export const MODEL_LIST: ModelCapability[] = [
  MODELS["claude-haiku-4.5"],
  MODELS["claude-sonnet-4.6"],
  MODELS["claude-opus-4.8"],
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
  const CACHE_WRITE_MULT = 1.25
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
