/**
 * Clasificación de los pasos de tool de UN mensaje del asistente para la UI.
 *
 * Problema que resuelve: cuando una tool devuelve un error recuperable que el
 * modelo corrige solo (703 → reescribe el SQL, SAP_TIMEOUT → reintenta y
 * funciona, SCHEMA_NOT_DISCOVERED → descubrir_esquema y vuelve a consultar),
 * pintar cada intento fallido como error hace sentir al usuario que el chat
 * "tira muchos errores" aunque la respuesta final salga bien.
 *
 * Función pura (sin React) para poder testearla sin DOM.
 */

/** Forma mínima de una tool part del AI SDK v6 que nos interesa. */
export type ToolStepInput = {
  toolCallId?: string
  toolName: string
  /** input-streaming | input-available | output-available | output-error | … */
  state: string
  output?: unknown
  errorText?: string
}

export type ToolStepError = {
  code?: string
  message?: string
  retryable?: boolean
  requestId?: string
}

/**
 * - `ok`: terminó bien.
 * - `pendiente`: sigue corriendo, o falló con un error recuperable mientras la
 *   respuesta aún está en streaming (el modelo todavía puede corregirlo).
 * - `corregido`: error con `retryable: true` y más adelante en el mismo mensaje
 *   hubo un éxito. Un error sin dato de `retryable` (output-error: excepción o
 *   input inválido) solo cuenta si el éxito posterior es de la misma tool o de
 *   una relacionada. `retryable: false` nunca es corregido.
 * - `fallido`: falló y no hubo éxito posterior (o el error no es recuperable).
 */
export type ToolStepStatus = "ok" | "pendiente" | "corregido" | "fallido"

export type ClassifiedToolStep = {
  status: ToolStepStatus
  /** Error del paso (output.error o errorText de output-error), si lo hubo. */
  error?: ToolStepError
  /** true si está `pendiente` por un error recuperable (UI: "reintentando…"). */
  retrying: boolean
}

/**
 * Tools que se corrigen entre sí (solo aplica a errores sin dato de `retryable`): un error en una se resuelve con otra del
 * mismo grupo (p.ej. 702 "tabla no accesible por SQL" → listar_registros;
 * SCHEMA_NOT_DISCOVERED → descubrir_esquema y de nuevo consultar_sql).
 * Una tool fuera de estos grupos solo se considera corregida por sí misma.
 */
const RELATED_GROUPS: ReadonlyArray<ReadonlySet<string>> = [
  new Set([
    "descubrir_esquema",
    "consultar_sql",
    "ejecutar_query_catalogo",
    "listar_queries_catalogo",
    "listar_registros",
    "obtener_documento",
  ]),
]

export function areRelatedTools(a: string, b: string): boolean {
  if (a === b) return true
  return RELATED_GROUPS.some((g) => g.has(a) && g.has(b))
}

/** Extrae el error de un paso: `{ error }` en el output, o el `errorText` de output-error. */
export function getToolStepError(step: ToolStepInput): ToolStepError | undefined {
  const out = step.output
  if (out && typeof out === "object" && "error" in out) {
    const e = (out as { error?: unknown }).error
    if (e && typeof e === "object") return e as ToolStepError
    if (typeof e === "string") return { message: e }
  }
  if (step.state === "output-error") return { message: step.errorText }
  return undefined
}

function isFinished(step: ToolStepInput): boolean {
  return step.state === "output-available" || step.state === "output-error"
}

function isSuccess(step: ToolStepInput): boolean {
  return step.state === "output-available" && !getToolStepError(step)
}

/**
 * Recuperable = el modelo puede corregirlo. `retryable: false` explícito
 * (SAP_UNAVAILABLE, SAP_AUTH, SAP_WRITE_UNCERTAIN…) no lo es; sin dato
 * (p.ej. output-error por input inválido) se trata como recuperable.
 */
function isRecoverable(error: ToolStepError): boolean {
  return error.retryable !== false
}

/**
 * Clasifica los pasos de tool de un mensaje del asistente, en orden.
 * @param steps  tool parts del mensaje, en el orden en que aparecen.
 * @param streaming true si este mensaje todavía se está generando.
 */
export function classifyToolSteps(steps: ToolStepInput[], streaming: boolean): ClassifiedToolStep[] {
  return steps.map((step, i) => {
    if (!isFinished(step)) return { status: "pendiente", retrying: false }

    const error = getToolStepError(step)
    if (!error) return { status: "ok", retrying: false }

    // `retryable: false` explícito (SAP_UNAVAILABLE, CHAT_TIMEOUT, TURN_BUDGET_EXHAUSTED…)
    // nunca cuenta como corregido: aunque haya un éxito después, el usuario debe
    // ver que ese paso no se completó (la respuesta puede estar incompleta).
    const later = steps.slice(i + 1)
    const corrected =
      error.retryable === true
        ? later.some(isSuccess)
        : error.retryable === undefined && later.some((s) => isSuccess(s) && areRelatedTools(step.toolName, s.toolName))
    if (corrected) return { status: "corregido", error, retrying: false }

    if (streaming && isRecoverable(error)) return { status: "pendiente", error, retrying: true }
    return { status: "fallido", error, retrying: false }
  })
}

/**
 * Texto humano para un paso `fallido` (nunca el código crudo). El detalle
 * técnico (message) queda disponible en la vista expandida.
 */
export function humanToolError(error: ToolStepError | undefined): string {
  const code = error?.code ?? ""
  if (code.startsWith("SQL_RULE_")) return "No se pudo armar una consulta válida para esta pregunta."
  switch (code) {
    case "SAP_TIMEOUT":
      return "SAP tardó demasiado en responder. Puede intentarlo de nuevo en unos minutos."
    case "SAP_UNAVAILABLE":
      return "No se pudo conectar con SAP en este momento."
    case "SAP_AUTH":
    case "BACKEND_AUTH":
      return "SAP rechazó el acceso. Contacte al administrador."
    case "SAP_NOT_FOUND":
      return "No se encontró ese registro en SAP."
    case "SAP_WRITE_UNCERTAIN":
      return "No se pudo confirmar si SAP registró la operación. Verifíquelo en SAP antes de repetirla."
    case "SAP_TABLE_NOT_ACCESSIBLE":
      return "Esa información no está disponible por esta vía de consulta."
    case "SAP_COLUMN_NOT_FOUND":
    case "SAP_QUERY_ERROR":
    case "SCHEMA_NOT_DISCOVERED":
    case "INVALID_QUERY":
      return "No se pudo armar una consulta válida para esta pregunta."
    case "INVALID_PERIOD":
      return "El período pedido no es válido."
    case "BAD_REQUEST":
      return "SAP no aceptó la solicitud."
    case "CHAT_TIMEOUT":
      return "El sistema tardó demasiado; la respuesta usa lo que alcanzó a consultar."
    case "TURN_BUDGET_EXHAUSTED":
      return "Se agotó el tiempo de esta respuesta."
    default:
      return "Este paso no se pudo completar."
  }
}
