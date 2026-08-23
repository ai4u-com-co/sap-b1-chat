/**
 * Resolución de la API key de Anthropic por tenant + clasificación de los
 * errores que devuelve la API de Anthropic.
 *
 * Por qué existe (incidente 2026-08-23): el chat de tamaprint respondía
 * "Your credit balance is too low to access the Anthropic API" y costó ~1 h
 * averiguar (a) que la key del chat vive en sap-b1-chat y no en el backend,
 * (b) que la key pertenecía a una ORGANIZACIÓN de Anthropic distinta a la que
 * se estaba mirando en el Console (la cuenta tiene 5 orgs con saldos
 * independientes), y (c) que era un error de facturación y no de SAP/tool
 * loop, porque el log solo decía "error durante streaming".
 *
 * Este módulo deja esas tres cosas explícitas en cada log:
 *   - `resolveAnthropicKey`  → de qué env var salió la key y su fingerprint
 *     (prefijo + sufijo, EXACTAMENTE lo que muestra platform.claude.com en
 *     "Claves de API", para cruzarlo contra las orgs sin exponer el secreto).
 *   - `classifyAnthropicError` → código estable (billing / auth / rate limit /
 *     overloaded / ...) + mensaje en español para el usuario final, que
 *     conserva el texto crudo de Anthropic entre paréntesis.
 *
 * Sin dependencias de Next ni de `ai` (solo el tipo de @ai-sdk/provider) para
 * que sea testeable en aislamiento.
 */
import { APICallError } from "@ai-sdk/provider"

// ── Key por tenant ────────────────────────────────────────────────

export type AnthropicKeySource = "tenant" | "global" | "none"

export type ResolvedAnthropicKey = {
  key: string
  /** `tenant` = `{TENANT}_ANTHROPIC_API_KEY`, `global` = `ANTHROPIC_API_KEY`, `none` = vacía. */
  source: AnthropicKeySource
  /** Nombre de la env var de la que salió la key (o la que se buscó primero si no hay ninguna). */
  envName: string
  /** Prefijo + sufijo, formato del Console de Anthropic (`sk-ant-api03-aub…vAAA`). Nunca el secreto. */
  fingerprint: string
}

/**
 * Fingerprint NO sensible de una key: los primeros 16 caracteres y los
 * últimos 4, que es exactamente cómo la lista el Console de Anthropic
 * (platform.claude.com/settings/keys). 20 de ~108 caracteres no permiten
 * reconstruir la key, y sí permiten saber en qué organización vive.
 */
export function keyFingerprint(key: string | undefined | null): string {
  if (!key) return "(vacía)"
  if (key.length <= 24) return `${key.slice(0, 6)}…(corta:${key.length})`
  return `${key.slice(0, 16)}…${key.slice(-4)}`
}

export function tenantKeyEnvName(tenantId: string): string {
  return `${tenantId.toUpperCase()}_ANTHROPIC_API_KEY`
}

export function resolveAnthropicKey(
  tenantId: string,
  env: Record<string, string | undefined> = process.env,
): ResolvedAnthropicKey {
  const tenantEnv = tenantKeyEnvName(tenantId)
  const tenantKey = env[tenantEnv]
  if (tenantKey) {
    return { key: tenantKey, source: "tenant", envName: tenantEnv, fingerprint: keyFingerprint(tenantKey) }
  }
  const globalKey = env.ANTHROPIC_API_KEY
  if (globalKey) {
    return { key: globalKey, source: "global", envName: "ANTHROPIC_API_KEY", fingerprint: keyFingerprint(globalKey) }
  }
  return { key: "", source: "none", envName: tenantEnv, fingerprint: "(vacía)" }
}

// ── Clasificación de errores ──────────────────────────────────────

export type AnthropicErrorCode =
  | "ANTHROPIC_BILLING"         // 400 — saldo de la ORG en $0 ("credit balance is too low")
  | "ANTHROPIC_AUTH"            // 401 — key inválida / revocada
  | "ANTHROPIC_PERMISSION"      // 403 — key sin permiso para el recurso
  | "ANTHROPIC_MODEL_NOT_FOUND" // 404 — modelo inexistente / retirado
  | "ANTHROPIC_RATE_LIMIT"      // 429
  | "ANTHROPIC_OVERLOADED"      // 529
  | "ANTHROPIC_SERVER"          // 5xx
  | "ANTHROPIC_INVALID_REQUEST" // 400 que no es billing
  | "NO_OUTPUT"                 // AI_NoOutputGeneratedError (el stream murió sin texto)
  | "UNKNOWN"

export type ClassifiedAnthropicError = {
  code: AnthropicErrorCode
  statusCode?: number
  /** `error.type` del body de Anthropic (`invalid_request_error`, `overloaded_error`, ...). */
  anthropicType?: string
  /** Mensaje crudo (el de Anthropic si pudo extraerse del body, si no el del Error). */
  rawMessage: string
  /** Mensaje para el usuario final, en español, con el crudo entre paréntesis. */
  userMessage: string
  retryable: boolean
  /** Qué tiene que hacer quien opera el sistema. Va al log, no al usuario. */
  operatorHint: string
}

type AnthropicErrorBody = { type?: string; error?: { type?: string; message?: string } }

function parseAnthropicBody(body: string | undefined): AnthropicErrorBody["error"] | undefined {
  if (!body) return undefined
  try {
    const parsed = JSON.parse(body) as AnthropicErrorBody
    return parsed?.error
  } catch {
    return undefined
  }
}

function baseMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

export function classifyAnthropicError(
  err: unknown,
  ctx: { tenantId?: string } = {},
): ClassifiedAnthropicError {
  const tenant = ctx.tenantId ?? "desconocido"
  const isApi = APICallError.isInstance(err)
  const statusCode = isApi ? err.statusCode : undefined
  const body = isApi ? parseAnthropicBody(err.responseBody) : undefined
  const anthropicType = body?.type
  const rawMessage = body?.message ?? baseMessage(err)
  const lower = rawMessage.toLowerCase()
  const errName = err instanceof Error ? err.name : ""

  const finish = (
    code: AnthropicErrorCode,
    userText: string,
    retryable: boolean,
    operatorHint: string,
  ): ClassifiedAnthropicError => ({
    code,
    statusCode,
    anthropicType,
    rawMessage,
    userMessage: `${userText} (${rawMessage})`,
    retryable,
    operatorHint,
  })

  // Billing: Anthropic lo manda como 400 invalid_request_error con este texto.
  // Se detecta por texto (y no solo por status) porque a veces llega envuelto
  // en un Error genérico a mitad del stream.
  if (lower.includes("credit balance") || lower.includes("purchase credits")) {
    return finish(
      "ANTHROPIC_BILLING",
      `La cuenta de IA del tenant ${tenant} no tiene crédito disponible. Contacta al administrador.`,
      false,
      `Saldo $0 en la ORGANIZACIÓN de Anthropic dueña de la key del tenant ${tenant}. ` +
        `Cruzar keyFingerprint contra platform.claude.com/settings/keys de cada org (la cuenta tiene varias) ` +
        `y recargar esa org, o apuntar ${tenantKeyEnvName(tenant)} (proyecto sap-b1-chat) a una key de una org con saldo.`,
    )
  }
  if (statusCode === 401 || anthropicType === "authentication_error" || lower.includes("invalid x-api-key")) {
    return finish(
      "ANTHROPIC_AUTH",
      `La credencial de IA del tenant ${tenant} es inválida o fue revocada. Contacta al administrador.`,
      false,
      `Key rechazada por Anthropic. Verificar ${tenantKeyEnvName(tenant)} en Vercel (sap-b1-chat) y que no esté revocada en el Console.`,
    )
  }
  if (statusCode === 403 || anthropicType === "permission_error") {
    return finish(
      "ANTHROPIC_PERMISSION",
      `La credencial de IA del tenant ${tenant} no tiene permiso para esta operación. Contacta al administrador.`,
      false,
      `Key sin permiso (workspace/modelo restringido). Revisar permisos de la key en el Console.`,
    )
  }
  if (statusCode === 404 || anthropicType === "not_found_error") {
    return finish(
      "ANTHROPIC_MODEL_NOT_FOUND",
      `El modelo de IA solicitado no está disponible. Prueba con otro modelo.`,
      false,
      `Modelo inexistente/retirado. Revisar lib/chat/models.ts contra el catálogo vigente de Anthropic.`,
    )
  }
  if (statusCode === 429 || anthropicType === "rate_limit_error" || lower.includes("rate limit")) {
    return finish(
      "ANTHROPIC_RATE_LIMIT",
      `El servicio de IA está recibiendo demasiadas solicitudes. Intenta de nuevo en unos segundos.`,
      true,
      `Rate limit de la org. Revisar platform.claude.com/settings/limits.`,
    )
  }
  if (statusCode === 529 || anthropicType === "overloaded_error" || lower.includes("overloaded")) {
    return finish(
      "ANTHROPIC_OVERLOADED",
      `El servicio de IA está saturado en este momento. Intenta de nuevo en unos segundos.`,
      true,
      `529 overloaded de Anthropic. Transitorio; si persiste, cambiar de modelo.`,
    )
  }
  if (statusCode !== undefined && statusCode >= 500) {
    return finish(
      "ANTHROPIC_SERVER",
      `El servicio de IA devolvió un error interno. Intenta de nuevo.`,
      true,
      `${statusCode} de Anthropic. Revisar status.anthropic.com.`,
    )
  }
  if (statusCode === 400 || anthropicType === "invalid_request_error") {
    return finish(
      "ANTHROPIC_INVALID_REQUEST",
      `La solicitud al servicio de IA fue rechazada.`,
      false,
      `400 de Anthropic que NO es billing: suele ser combinación inválida de modelo/thinking/effort o prompt demasiado largo.`,
    )
  }
  if (errName === "AI_NoOutputGeneratedError" || lower.includes("no output generated")) {
    return finish(
      "NO_OUTPUT",
      `El asistente no pudo generar una respuesta. Intenta de nuevo.`,
      true,
      `El stream terminó sin texto. Casi siempre hay OTRO error antes en el mismo request (buscar el onError previo con el mismo rid).`,
    )
  }
  return {
    code: "UNKNOWN",
    statusCode,
    anthropicType,
    rawMessage,
    // Sin clasificar se devuelve el crudo tal cual (comportamiento previo).
    userMessage: rawMessage,
    retryable: false,
    operatorHint: `Error no clasificado (${errName || typeof err}). Revisar el campo err completo.`,
  }
}

/** Forma compacta para meter en el log junto al `err` completo. */
export function anthropicErrorLogFields(
  classified: ClassifiedAnthropicError,
  key: Pick<ResolvedAnthropicKey, "source" | "envName" | "fingerprint">,
) {
  return {
    anthropicCode: classified.code,
    anthropicStatus: classified.statusCode,
    anthropicType: classified.anthropicType,
    anthropicMessage: classified.rawMessage,
    operatorHint: classified.operatorHint,
    keySource: key.source,
    keyEnv: key.envName,
    keyFingerprint: key.fingerprint,
  }
}
