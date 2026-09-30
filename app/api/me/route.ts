import { withApiHandler, type ApiContext } from "@ai4u/platform/http"
import { getApiKey, getTenantId } from "@/app/lib/session"
import { getBackendUrl, sapBackendUnavailableResponse } from "@/lib/sap-gateway"

export const GET = withApiHandler(async (_req: Request, apiCtx: ApiContext) => {
  const [apiKey, tenantId] = await Promise.all([getApiKey(), getTenantId()])

  if (!apiKey || !tenantId) {
    return Response.json({ error: "No autorizado" }, { status: 401 })
  }

  try {
    const res = await fetch(`${getBackendUrl()}/api/v1/me`, {
      headers: { "X-API-Key": apiKey },
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
