/**
 * Timeout defensivo por-llamada para cualquier `await client.*` (BackendClient,
 * @ai4u/contracts) hecho desde una tool del chat.
 *
 * Por qué existe: `route.ts` tiene `maxDuration = 300` (el único límite de tiempo
 * de toda la función serverless), pero `BackendClient.get/post/patch` (contracts
 * `src/backend-client.ts`) usa `fetch()` sin `AbortSignal` ni timeout propio. Si el
 * gateway sap-b1-backend o Service Layer/HANA se cuelga respondiendo, ese `await`
 * queda pendiente hasta que Vercel mata la función a los 300s duros — un kill
 * externo que no pasa por ningún `onError` de la AI SDK, así que el stream nunca
 * cierra y el cliente (ChatUI) se queda con el spinner de la tool congelado para
 * siempre. Ver incidente 2026-08-31, rid=398894ad (`consultar_sql` colgado en
 * "Ejecutando consulta SQL en SAP…").
 *
 * `withSapTimeout` hace que ese `await` falle LIMPIO mucho antes del kill duro,
 * con un mensaje que contiene la palabra "timeout" — `classifySapError` (route.ts)
 * ya reconoce esa palabra y la clasifica como `{ code: "SAP_TIMEOUT", retryable:
 * true }`, así que no hace falta ningún cambio en los `catch` existentes: basta
 * con envolver la llamada.
 *
 * No cancela el `fetch` subyacente (BackendClient no expone forma de abortarlo) —
 * solo hace que la tool deje de esperarlo. El fetch abandonado sigue corriendo en
 * background hasta que responde o hasta que Vercel mata la función al final del
 * request; no es un leak entre requests.
 */
export const SAP_TOOL_TIMEOUT_MS = 75_000

export function withSapTimeout<T>(
  promise: Promise<T>,
  ms: number = SAP_TOOL_TIMEOUT_MS
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`timeout: SAP B1 no respondió en ${ms}ms`))
    }, ms)
  })
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer))
}
