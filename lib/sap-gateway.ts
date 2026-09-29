/**
 * Lectura de la configuración hacia el gateway SAP (`sap-b1-backend`), el ÚNICO
 * borde con SAP B1. Solo resuelve URL y llave: las llamadas SAP del chat van por
 * `BackendClient` de @ai4u/contracts (que lee su propia URL; ver README del PR).
 *
 * Contrato de env Ai4U (fase 1):
 *   - URL: SAP_BACKEND_URL → alias BACKEND_URL, NEXT_PUBLIC_BACKEND_URL (con aviso).
 *   - Llave: getGatewayApiKey(tenant) → {TENANT}_SAP_API_KEY → alias → SAP_BACKEND_API_KEY.
 */
import { getGatewayApiKey, readEnv, type EnvSource } from "@ai4u/config/env"

/**
 * Fallback histórico cuando no hay URL configurada. PELIGROSO en producción (apunta a
 * localhost); se conserva para no cambiar comportamiento en este PR (fase 1).
 */
export const LOCAL_GATEWAY_URL = "http://localhost:4100"

/**
 * Valor histórico de X-API-Key cuando el tenant no tiene llave propia: el gateway
 * ignora ese valor y autentica por `x-mc-secret` (BackendClient lo manda).
 */
export const S2S_AUTH_PLACEHOLDER = "S2S_AUTH"

export function getBackendUrl(env?: EnvSource): string {
  return readEnv("SAP_BACKEND_URL", env) ?? LOCAL_GATEWAY_URL
}

/** Llave X-API-Key del tenant de la sesión, o el placeholder "S2S_AUTH" si no tiene. */
export function resolveGatewayApiKey(tenantId: string, env?: EnvSource): string {
  try {
    return getGatewayApiKey(tenantId, env)?.key ?? S2S_AUTH_PLACEHOLDER
  } catch {
    // normalizeTenant lanza con ids vacíos/inválidos: mismo resultado que "sin llave".
    return S2S_AUTH_PLACEHOLDER
  }
}
