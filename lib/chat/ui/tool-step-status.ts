/**
 * Clasificación de los pasos de tool de UN mensaje del asistente para la UI.
 *
 * Problema que resuelve: cuando una tool falla y el modelo lo resuelve solo
 * (703 → reescribe el SQL, SAP_TIMEOUT → reintenta, o resuelve por otra vía:
 * buscar_socio_o_item falla → consultar_sql + compras_proveedor), pintar cada
 * intento fallido como error hace sentir al usuario que el chat "tira muchos
 * errores" aunque la respuesta final salga bien.
 *
 * Evidencia (Flexo 29-sep-2026, rid 5493f17a): 2× buscar_socio_o_item con
 * SAP_QUERY_ERROR (retryable:false) → consultar_sql ok → compras_proveedor ok y
 * respuesta final correcta; los 2 fallos quedaban en naranja como "fallido".
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
 * - `pendiente`: sigue corriendo, o falló sin éxito posterior mientras la
 *   respuesta aún está en streaming (el modelo todavía puede sortearlo).
 * - `corregido`: falló pero DESPUÉS, en el mismo mensaje, hubo al menos un paso
 *   exitoso de cualquier tool: el asistente lo sorteó (reintento, otra consulta u
 *   otra tool). Da igual el `retryable` del error. Excepción: SAP_WRITE_UNCERTAIN.
 * - `fallido`: falló y no hubo ningún éxito posterior en el mensaje (ya
 *   terminado), o es SAP_WRITE_UNCERTAIN.
 */
export type ToolStepStatus = "ok" | "pendiente" | "corregido" | "fallido"

export type ClassifiedToolStep = {
  status: ToolStepStatus
  /** Error del paso (output.error o errorText de output-error), si lo hubo. */
  error?: ToolStepError
  /** true si está `pendiente` por un error que el modelo todavía puede sortear (UI: "reintentando…"). */
  retrying: boolean
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
 * Errores que nunca se ocultan como "corregido", aunque después algo funcione:
 * SAP_WRITE_UNCERTAIN = una escritura que SAP pudo haber registrado o no; el
 * usuario tiene que verla para revisarlo en SAP antes de repetirla.
 */
const NEVER_CORRECTED = new Set(["SAP_WRITE_UNCERTAIN"])

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

    if (NEVER_CORRECTED.has(error.code ?? "")) return { status: "fallido", error, retrying: false }

    // Cualquier éxito posterior (de cualquier tool) significa que el asistente
    // sorteó este fallo. Los pasos solo se agregan al final, así que esto no
    // cambia al terminar el streaming.
    if (steps.slice(i + 1).some(isSuccess)) return { status: "corregido", error, retrying: false }

    // Sin éxito posterior todavía: mientras el mensaje se genera, neutro.
    if (streaming) return { status: "pendiente", error, retrying: true }
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
