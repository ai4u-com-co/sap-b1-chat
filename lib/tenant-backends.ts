import { readEnv } from "@/lib/env"

export type BackendType = "sap" | "proxy"

export interface TenantBackend {
  type: BackendType
  proxyUrl?: string
}

export function getTenantBackend(tenantId: string): TenantBackend {
  if (tenantId === "magdalena") {
    return { type: "proxy", proxyUrl: readEnv("MAGDALENA_CHAT_URL") }
  }
  return { type: "sap" }
}
