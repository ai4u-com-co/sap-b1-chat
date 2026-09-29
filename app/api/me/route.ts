import { withApiHandler } from "@ai4u/platform/http"
import { getApiKey, getTenantId } from "@/app/lib/session"
import { getBackendUrl } from "@/lib/sap-gateway"

export const GET = withApiHandler(async () => {
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
  } catch { /* backend not reachable */ }

  // Fallback: return tenantId from session
  return Response.json({ tenant: tenantId, name: tenantId })
}, { label: "GET me" }) as () => Promise<Response>
