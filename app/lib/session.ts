import { cookies } from "next/headers"
import { verifySession } from "@ai4u/mc-sso"
import { readEnv } from "@/lib/env"
import { resolveGatewayApiKey } from "@/lib/sap-gateway"

export const COOKIE = "sap_chat_session"

export interface TenantSession {
  tenantId:        string
  displayName:     string  // nombre del tenant (o tenantId como fallback)
  userId?:         string
  roles?:          string[]
  allowedModules?: string[] | null
}

// Decodifica la cookie de sesión y expone identidad+permisos embebidos por el
// handoff de Mission Control. Devuelve null si no hay sesión válida.
export async function getSession(): Promise<TenantSession | null> {
  const cookieStore = await cookies()
  const token   = cookieStore.get(COOKIE)?.value ?? ""
  const secret  = readEnv("MISSION_CONTROL_SECRET") ?? ""
  const payload = verifySession(token, secret)
  if (!payload) return null
  return {
    tenantId:       payload.tenantId,
    displayName:    payload.displayName ?? payload.tenantId,
    userId:         payload.userId,
    roles:          payload.roles,
    allowedModules: payload.allowedModules ?? null,
  }
}

export async function getTenantId(): Promise<string | null> {
  const cookieStore = await cookies()
  const token  = cookieStore.get(COOKIE)?.value ?? ""
  const secret = readEnv("MISSION_CONTROL_SECRET") ?? ""
  return verifySession(token, secret)?.tenantId ?? null
}

export async function getApiKey(): Promise<string | null> {
  const tenantId = await getTenantId()
  if (!tenantId) return null
  // {TENANT}_SAP_API_KEY (contrato de env) o el placeholder "S2S_AUTH" (auth por x-mc-secret).
  return resolveGatewayApiKey(tenantId)
}
