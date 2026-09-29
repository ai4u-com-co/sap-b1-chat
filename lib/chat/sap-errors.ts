import { BackendError } from "@ai4u/contracts"
import { classifyColumnNotFound } from "@/lib/chat/sql-error-hints"
import { ChatStoppedWaitingError, TurnBudgetExhaustedError } from "@/lib/chat/with-timeout"

/**
 * Error que las tools devuelven al LLM como `{ error }` (retorno normal, no excepción).
 * `requestId` = x-request-id enviado al backend: une este error con su log en
 * `platform_logs` (service='sap-b1-backend', request_id) y con `chat_tool_calls`.
 */
export type SapError = { code: string; message: string; retryable: boolean; requestId?: string }

// Mensajes pensados para el LLM: dicen QUÉ hacer, no solo qué pasó. La auditoría
// del 29-sep mostró que un timeout de SAP clasificado como error de la consulta
// hacía que el LLM reescribiera el SQL una y otra vez (más errores, turno más largo).
//
// SAP_SLOW solo se usa cuando el TIMEOUT lo clasificó el gateway (BackendError):
// el backend ya terminó, así que un reintento no compite con nada. El chat
// además no inicia el reintento si no queda presupuesto del turno
// (createTurnBudget, lib/chat/with-timeout.ts).
const SAP_SLOW =
  "SAP B1 está lento o no respondió a tiempo. Es un problema temporal de SAP, NO de tu consulta: " +
  "no reescribas el SQL ni cambies de herramienta. Reintenta UNA sola vez la misma llamada; si vuelve a fallar, " +
  "dile al usuario que SAP está lento y que lo intente en unos minutos."
// El CHAT dejó de esperar (incidente 29-sep: corte a 75 004 ms con el backend
// todavía trabajando). Reintentar lanzaría la misma consulta en paralelo con la
// primera, que sigue corriendo en SAP.
const CHAT_GAVE_UP =
  "El chat dejó de esperar la respuesta de SAP: la consulta tardó más de lo permitido y puede seguir ejecutándose en SAP. " +
  "NO reintentes la misma llamada ni variantes (competiría con la que sigue en curso). Responde con los datos que ya tienes " +
  "y dile al usuario que SAP está tardando más de lo normal y que lo intente de nuevo en unos minutos."
const TURN_BUDGET =
  "No queda tiempo en esta respuesta para otra consulta a SAP. NO llames más herramientas de SAP: responde YA con los " +
  "datos que tienes y dile al usuario qué parte quedó sin consultar para que la pida en un mensaje nuevo."
const SAP_DOWN =
  "No se pudo comunicar con SAP B1 (servidor caído o sin red). Es un problema de infraestructura, NO de tu consulta: " +
  "no reintentes variantes. Dile al usuario que SAP no está disponible en este momento."
const TABLE_NOT_SQL =
  "Esta tabla no es accesible vía SQL en este conector (ej. OITB, OSLP, OIGN). Usa el endpoint OData equivalente " +
  "(listar_registros / obtener_documento) en vez de consultar_sql."

function err(code: string, message: string, retryable: boolean, requestId?: string): { error: SapError } {
  return { error: requestId ? { code, message, retryable, requestId } : { code, message, retryable } }
}

function fromBackendError(e: BackendError): { error: SapError } {
  const rid = e.requestId

  // 703 con tabla/columna estructuradas (envelope nuevo del backend).
  if (e.table && e.column) {
    const hint = classifyColumnNotFound(`Column '${e.column}' from table '${e.table}' not exist`)
    if (hint) return { error: rid ? { ...hint, requestId: rid } : hint }
  }
  if (e.sapMessage) {
    const hint = classifyColumnNotFound(e.sapMessage)
    if (hint) return { error: rid ? { ...hint, requestId: rid } : hint }
  }
  if (e.sapCode === "702") return err("SAP_TABLE_NOT_ACCESSIBLE", TABLE_NOT_SQL, true, rid)

  switch (e.code) {
    case "SAP_TIMEOUT":
      return err("SAP_TIMEOUT", SAP_SLOW, true, rid)
    case "SAP_UNREACHABLE":
    case "SAP_AUTH_UNAVAILABLE":
      return err("SAP_UNAVAILABLE", SAP_DOWN, false, rid)
    case "SAP_UNAUTHORIZED":
    case "SAP_FORBIDDEN":
      return err("SAP_AUTH", "SAP rechazó las credenciales del tenant. No reintentes: dile al usuario que contacte al administrador.", false, rid)
    case "NOT_FOUND":
      return err("SAP_NOT_FOUND", "El registro no existe en SAP. Verifica el código/número o búscalo con listar_registros.", false, rid)
    case "SAP_WRITE_UNCERTAIN":
      return err("SAP_WRITE_UNCERTAIN", e.backendMessage ?? "No se pudo confirmar si SAP procesó la escritura. NO reintentes.", false, rid)
    case "SAP_QUERY_ERROR": {
      const detail = e.sapMessage ? ` Detalle de SAP${e.sapCode ? ` (${e.sapCode})` : ""}: ${e.sapMessage}` : ""
      return err(
        "SAP_QUERY_ERROR",
        `SAP rechazó la consulta.${detail} Corrige la consulta según el detalle; si no hay detalle, llama descubrir_esquema antes de reintentar.`,
        true,
        rid,
      )
    }
  }

  // Sin code: p. ej. 504 de la plataforma con cuerpo HTML (el backend no alcanzó a responder).
  if (e.status === 504 || e.status === 408) return err("SAP_TIMEOUT", SAP_SLOW, true, rid)
  if (e.status === 401 || e.status === 403) return err("BACKEND_AUTH", "El backend rechazó la autenticación del chat. No reintentes: es un problema de configuración.", false, rid)
  if (e.status === 400) return err("BAD_REQUEST", e.backendMessage ?? "El backend rechazó la solicitud (400). Revisa los parámetros de la herramienta.", true, rid)

  // Nunca el cuerpo crudo: solo el mensaje seguro del backend si lo hay.
  return err(e.code ?? "BACKEND_ERROR", e.backendMessage ?? `Error del backend (HTTP ${e.status}).`, false, rid)
}

/**
 * Clasifica cualquier error de una tool SAP en un `{ error: SapError }` accionable
 * para el LLM. Con `BackendError` (contracts >= 0.5.0) usa los campos
 * estructurados; los cortes propios del chat (ChatStoppedWaitingError,
 * TurnBudgetExhaustedError) por tipo; el resto de errores locales (red) por texto
 * sin distinguir mayúsculas. Solo el SAP_TIMEOUT que viene del gateway es
 * reintentable: un timeout local significa que el backend puede seguir trabajando.
 */
export function classifySapError(e: unknown): { error: SapError } {
  if (e instanceof BackendError) return fromBackendError(e)
  if (e instanceof ChatStoppedWaitingError) return err("CHAT_TIMEOUT", CHAT_GAVE_UP, false)
  if (e instanceof TurnBudgetExhaustedError) return err("TURN_BUDGET_EXHAUSTED", TURN_BUDGET, false)

  const msg = e instanceof Error ? e.message : String(e)
  const lower = msg.toLowerCase()
  const columnError = classifyColumnNotFound(msg)
  if (columnError) return { error: columnError }
  // Timeout/abort LOCAL (no clasificado por el gateway): fue este proceso el que
  // dejó de esperar, el backend puede seguir trabajando → no reintentable.
  if (lower.includes("timeout") || lower.includes("aborted")) return err("CHAT_TIMEOUT", CHAT_GAVE_UP, false)
  if (lower.includes("fetch failed") || lower.includes("econnrefused") || lower.includes("enotfound"))
    return err("SAP_UNAVAILABLE", SAP_DOWN, false)
  return err("SAP_ERROR", "Error inesperado al consultar SAP. No reintentes variantes; informa al usuario.", false)
}
