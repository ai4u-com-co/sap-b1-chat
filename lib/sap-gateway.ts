/**
 * Lectura de la configuración hacia el gateway SAP (`sap-b1-backend`), el ÚNICO
 * borde con SAP B1. Solo resuelve URL y llave: las llamadas SAP del chat van por
 * `BackendClient` de @ai4u/contracts, que recibe esta misma URL como `baseUrl`.
 *
 * Contrato de env Ai4U (fase 1):
 *   - URL: SAP_BACKEND_URL → alias BACKEND_URL, NEXT_PUBLIC_BACKEND_URL (con aviso).
 *   - Llave: getGatewayApiKey(tenant) → {TENANT}_SAP_API_KEY → alias → SAP_BACKEND_API_KEY.
 *     Sin llave para el tenant → null (fail-closed): ya no existe el placeholder
 *     "S2S_AUTH" que dejaba autenticar por el secreto compartido `x-mc-secret`.
 */
import { getGatewayApiKey, readEnv, type EnvSource } from "@ai4u/config/env"

/**
 * URL del gateway en local. SOLO conveniencia para preview/development: en Production
 * de Vercel (`VERCEL_ENV=production`) nunca se usa — si falta SAP_BACKEND_URL (y sus
 * alias) `getBackendUrl` lanza `SapBackendUrlMissingError` en vez de apuntar en
 * silencio a localhost (conexión rechazada).
 */
export const LOCAL_GATEWAY_URL = "http://localhost:4100"

/** Falta la URL del gateway en Production. El handler la convierte en 503 genérico. */
export class SapBackendUrlMissingError extends Error {
  constructor() {
    super("SAP_BACKEND_URL no configurada")
    this.name = "SapBackendUrlMissingError"
  }
}

/**
 * URL base del gateway: SAP_BACKEND_URL → alias (con aviso). Sin ninguna:
 * en Production lanza `SapBackendUrlMissingError`; en preview/development, localhost.
 */
export function getBackendUrl(env?: EnvSource): string {
  const url = readEnv("SAP_BACKEND_URL", env)
  if (url) return url
  if ((env ?? process.env).VERCEL_ENV === "production") throw new SapBackendUrlMissingError()
  return LOCAL_GATEWAY_URL
}

/**
 * Respuesta 503 con mensaje genérico si `err` es la falta de URL del gateway; si no, null
 * (el handler sigue con su respuesta de error de siempre). Uso en el catch:
 * `return sapBackendUnavailableResponse(err) ?? Response.json(..., { status: 500 })`.
 */
export function sapBackendUnavailableResponse(err: unknown): Response | null {
  if (!(err instanceof SapBackendUrlMissingError)) return null
  return Response.json({ error: "Servicio SAP no disponible temporalmente" }, { status: 503 })
}

/**
 * Llave X-API-Key del tenant de la sesión, o null si no tiene. Sin llave no se
 * llama al gateway (fail-closed): antes se mandaba el placeholder "S2S_AUTH" y el
 * gateway autenticaba por el secreto compartido `x-mc-secret`.
 */
export function resolveGatewayApiKey(tenantId: string, env?: EnvSource): string | null {
  try {
    return getGatewayApiKey(tenantId, env)?.key ?? null
  } catch {
    // normalizeTenant lanza con ids vacíos/inválidos: mismo resultado que "sin llave".
    return null
  }
}
