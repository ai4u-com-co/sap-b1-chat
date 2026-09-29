/**
 * Presupuestos de tiempo de las llamadas del chat al gateway sap-b1-backend.
 *
 * ── Por qué existe el timeout por llamada ─────────────────────────────────────
 * `route.ts` tiene `maxDuration = 300` (el único límite de tiempo de toda la
 * función serverless), pero `BackendClient.get/post/patch` (@ai4u/contracts
 * `src/backend-client.ts`) usa `fetch()` sin `AbortSignal` ni timeout propio. Si
 * el gateway o Service Layer/HANA se cuelga, ese `await` queda pendiente hasta
 * que Vercel mata la función a los 300 s duros — un kill externo que no pasa por
 * ningún `onError` de la AI SDK, y el spinner de la tool queda congelado. Ver
 * incidente 2026-08-31, rid=398894ad.
 *
 * ── Por qué el timeout está alineado con el backend (incidente 2026-09-29) ────
 * El gateway tiene un presupuesto de 55 s por llamada a SAP
 * (`SAP_REQUEST_BUDGET_MS`, sap-b1-backend lib/sap/client.ts) y sus rutas lentas
 * declaran `maxDuration = 60`. Con el viejo tope de 75 s el chat cortaba a
 * ciegas (75 004 ms) mientras el backend seguía trabajando, y el LLM reintentaba
 * la MISMA consulta en paralelo con la primera todavía en curso. La regla ahora:
 *
 *   timeout del chat por tool = techo del backend (60 s) + margen de red (5 s)
 *
 * así el backend responde SIEMPRE antes (con su `SAP_TIMEOUT` limpio, que sí es
 * reintentable). Si aun así el chat corta, el error es `ChatStoppedWaitingError`
 * — "el chat dejó de esperar", NO "SAP no respondió" — y no se reintenta.
 *
 * ── Presupuesto global del turno ──────────────────────────────────────────────
 * Varias tools en serie pueden agotar los 300 s del route. `createTurnBudget`
 * fija el deadline del turno y NO inicia una llamada SAP nueva (ni reintento) si
 * lo que queda no alcanza para una llamada completa + el cierre del LLM:
 * devuelve `TurnBudgetExhaustedError`, que le dice al modelo que responda con lo
 * que ya tiene.
 *
 * No se cancela el `fetch` subyacente (BackendClient no expone forma de
 * abortarlo): solo se deja de esperarlo.
 */

/** Presupuesto por llamada SAP del gateway: `SAP_REQUEST_BUDGET_MS` en sap-b1-backend lib/sap/client.ts. */
export const BACKEND_SAP_BUDGET_MS = 55_000
/** Techo por request de las rutas del gateway que lo declaran (`maxDuration = 60`: /kpis, /insights/*, /finance/*…). */
export const BACKEND_MAX_DURATION_MS = 60_000
/** Margen de red/cola entre el fin del backend y la llegada de la respuesta al chat. */
export const NETWORK_MARGIN_MS = 5_000
/** Timeout del chat por llamada SAP: siempre mayor que lo que el backend puede tardar en responder. */
export const SAP_TOOL_TIMEOUT_MS = BACKEND_MAX_DURATION_MS + NETWORK_MARGIN_MS // 65_000
/** Tiempo que se reserva al final del turno para que el LLM escriba la respuesta. */
export const LLM_CLOSING_RESERVE_MS = 15_000
/** Una llamada SAP nueva solo se inicia si queda al menos esto del turno (llamada completa + cierre). */
export const MIN_TURN_LEFT_FOR_SAP_CALL_MS = SAP_TOOL_TIMEOUT_MS + LLM_CLOSING_RESERVE_MS // 80_000

/**
 * El CHAT dejó de esperar al gateway. El backend probablemente sigue trabajando:
 * reintentar competiría con esa ejecución. Distinto de un `SAP_TIMEOUT` del
 * gateway (BackendError), que sí significa "SAP no respondió" con el backend ya libre.
 */
export class ChatStoppedWaitingError extends Error {
  readonly waitedMs: number
  constructor(waitedMs: number) {
    super(`timeout: el chat dejó de esperar al gateway SAP tras ${waitedMs}ms (el backend puede seguir procesando)`)
    this.name = "ChatStoppedWaitingError"
    this.waitedMs = waitedMs
  }
}

/** No queda presupuesto del turno para iniciar otra llamada SAP: no se envió nada al backend. */
export class TurnBudgetExhaustedError extends Error {
  readonly remainingMs: number
  constructor(remainingMs: number) {
    super(`presupuesto del turno agotado: quedan ${Math.max(0, Math.round(remainingMs))}ms, se necesitan ${MIN_TURN_LEFT_FOR_SAP_CALL_MS}ms para otra llamada SAP`)
    this.name = "TurnBudgetExhaustedError"
    this.remainingMs = remainingMs
  }
}

export function withSapTimeout<T>(
  promise: Promise<T>,
  ms: number = SAP_TOOL_TIMEOUT_MS
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new ChatStoppedWaitingError(ms))
    }, ms)
  })
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer))
}

export type TurnBudget = {
  /** Epoch ms en que Vercel corta la función. */
  readonly deadline: number
  remainingMs(): number
  /**
   * Ejecuta UNA llamada SAP dentro del presupuesto del turno. Es lazy a propósito:
   * si no queda tiempo, `call` nunca se invoca (no llega ningún request al backend).
   */
  sap<T>(call: () => Promise<T>): Promise<T>
}

export function createTurnBudget(opts: {
  /** `maxDuration` del route, en ms. */
  maxDurationMs: number
  startedAt?: number
  now?: () => number
  toolTimeoutMs?: number
  minLeftForCallMs?: number
}): TurnBudget {
  const now = opts.now ?? Date.now
  const deadline = (opts.startedAt ?? now()) + opts.maxDurationMs
  const toolTimeoutMs = opts.toolTimeoutMs ?? SAP_TOOL_TIMEOUT_MS
  const minLeft = opts.minLeftForCallMs ?? MIN_TURN_LEFT_FOR_SAP_CALL_MS
  const remainingMs = () => deadline - now()
  return {
    deadline,
    remainingMs,
    sap<T>(call: () => Promise<T>): Promise<T> {
      const left = remainingMs()
      if (left < minLeft) return Promise.reject(new TurnBudgetExhaustedError(left))
      let p: Promise<T>
      try {
        p = call()
      } catch (e) {
        return Promise.reject(e)
      }
      return withSapTimeout(p, toolTimeoutMs)
    },
  }
}
