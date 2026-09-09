/**
 * Trazabilidad incremental de tool calls (Fix #2 del incidente 2026-08-31).
 *
 * Antes de este fix, `onFinish` (route.ts) era el ÚNICO lugar que persistía algo
 * en Supabase, y solo corría si el turno completaba. Un turno que muere a mitad
 * (el timeout de `withSapTimeout`, o cualquier otro fallo futuro que mate el
 * stream) no dejaba NINGÚN rastro server-side de qué tool se alcanzó a llamar.
 *
 * Este módulo construye (función pura, testeable sin Supabase — mismo patrón que
 * `fetchDocumentoConFallback`/`fetchListarRegistrosConFallback`) la fila que se
 * inserta en `chat_tool_calls` cada vez que una tool termina, vía
 * `experimental_onToolCallFinish` de `streamText` (route.ts) — un único punto de
 * enganche que NO requiere tocar las ~30 definiciones de tool individuales.
 */

export interface ToolCallLogRow {
  session_id: string
  tenant_id: string
  tool_name: string
  tool_call_id: string
  step_number: number | null
  duration_ms: number
  success: boolean
  input: unknown
  output: unknown
}

// Límite generoso para no guardar payloads gigantes (ej. un `consultar_sql` con
// miles de filas) — igual que el truncado a 20/30 filas que ya hacen las tools
// hacia el modelo, esto es solo para que la fila quede en Supabase, no para
// servir de storage completo de resultados SAP.
const MAX_JSON_CHARS = 8000

function truncateForStorage(value: unknown): unknown {
  if (value === undefined) return null
  let json: string
  try {
    json = JSON.stringify(value)
  } catch {
    return { unstringifiable: true }
  }
  if (json.length <= MAX_JSON_CHARS) return value
  return { truncated: true, preview: json.slice(0, MAX_JSON_CHARS) }
}

/**
 * Casi todas las tools de route.ts capturan sus propios errores y devuelven
 * `{ error: { code, message, retryable } }` como valor de retorno NORMAL (ver
 * `classifySapError` en route.ts) — no como excepción. Por eso el `success` que
 * reporta el SDK (`event.success` de `experimental_onToolCallFinish`, que solo es
 * `false` si la tool literalmente tiró) casi siempre es `true` aunque SAP haya
 * rechazado la consulta. Miramos también la forma del output para reflejar el
 * error real en la fila.
 */
function looksLikeToolError(output: unknown): boolean {
  return !!output && typeof output === "object" && "error" in (output as Record<string, unknown>)
}

export function buildToolCallLogRow(args: {
  sessionId: string
  tenantId: string
  toolName: string
  toolCallId: string
  stepNumber: number | undefined
  durationMs: number
  input: unknown
  /** event.success de experimental_onToolCallFinish (¿tiró la tool?) */
  sdkSuccess: boolean
  /** event.output cuando sdkSuccess=true */
  output?: unknown
  /** event.error cuando sdkSuccess=false */
  error?: unknown
}): ToolCallLogRow {
  const { sessionId, tenantId, toolName, toolCallId, stepNumber, durationMs, input, sdkSuccess, output, error } = args
  const effectiveOutput = sdkSuccess
    ? output
    : { thrown: error instanceof Error ? error.message : String(error) }

  return {
    session_id: sessionId,
    tenant_id: tenantId,
    tool_name: toolName,
    tool_call_id: toolCallId,
    step_number: stepNumber ?? null,
    duration_ms: durationMs,
    success: sdkSuccess && !looksLikeToolError(effectiveOutput),
    input: truncateForStorage(input),
    output: truncateForStorage(effectiveOutput),
  }
}

/** Cliente mínimo inyectable — evita acoplar este módulo al tipo completo de @supabase/supabase-js */
export interface ToolCallLogClient {
  from(table: string): { insert(row: ToolCallLogRow): PromiseLike<unknown> }
}

// `experimental_onToolCallFinish` (route.ts) espera a que esta promesa resuelva
// antes de dejar avanzar el siguiente step del tool loop. Sin límite propio, un
// Supabase colgado reintroduciría exactamente la misma clase de bug que motivó
// `withSapTimeout` (lib/chat/with-timeout.ts) — esta vez del lado de logging, no
// de SAP. 5s es generoso para un insert de una fila; si se agota, se descarta la
// fila (best-effort) y el turno sigue sin verse afectado.
const LOG_INSERT_TIMEOUT_MS = 5_000

export async function logToolCallResult(client: ToolCallLogClient, row: ToolCallLogRow): Promise<void> {
  let timer: ReturnType<typeof setTimeout>
  try {
    await Promise.race([
      client.from("chat_tool_calls").insert(row),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("chat_tool_calls insert timeout")), LOG_INSERT_TIMEOUT_MS)
      }),
    ])
  } catch {
    // Best-effort: un fallo (o timeout) al loguear nunca debe romper el turno del chat.
  } finally {
    clearTimeout(timer!)
  }
}
