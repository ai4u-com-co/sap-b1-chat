import { withApiHandler, type ApiContext } from "@ai4u/platform/http"
import { getGatewayIdentityHeaders } from "@ai4u/platform/gateway-identity"
import { getApiKey, getTenantId } from "@/app/lib/session"
import { getBackendUrl, sapBackendUnavailableResponse } from "@/lib/sap-gateway"

export const GET = withApiHandler(async (_req: Request, apiCtx: ApiContext) => {
  const [apiKey, tenantId] = await Promise.all([getApiKey(), getTenantId()])

  if (!tenantId) {
    return Response.json({ error: "No autorizado" }, { status: 401 })
  }

  // Sin llave del tenant (p. ej. tenants proxy como magdalena) no se llama al gateway:
  // mismo resultado que antes, cuando se mandaba "S2S_AUTH" y el gateway respondía 401.
  if (!apiKey) return Response.json({ tenant: tenantId, name: tenantId })

  try {
    const res = await fetch(`${getBackendUrl()}/api/v1/me`, {
      // + identidad OIDC (`x-ai4u-identity`, Fase 3) si hay token; fail-open, la auth sigue siendo X-API-Key.
      headers: { "X-API-Key": apiKey, ...(await getGatewayIdentityHeaders()) },
      cache: "no-store",
    })
    if (res.ok) {
      const data = await res.json()
      return Response.json(data)
    }
  } catch (err) {
    // Falta la URL del gateway en Production: 503 genérico + log ERROR (no es "backend caído").
    const unavailable = sapBackendUnavailableResponse(err)
    if (unavailable) {
      apiCtx.log.error({ err }, "me: SAP_BACKEND_URL no configurada")
      return unavailable
    }
    /* backend not reachable */
  }

  // Fallback: return tenantId from session
  return Response.json({ tenant: tenantId, name: tenantId })
}, { label: "GET me" }) as () => Promise<Response>
