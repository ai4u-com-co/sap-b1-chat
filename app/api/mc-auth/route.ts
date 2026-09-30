import { createMcAuthHandler } from "@ai4u/mc-sso"
import { withApiHandler } from "@ai4u/platform/http"
import { COOKIE, SESSION_TTL_MS } from "@/app/lib/session"
import { readEnv } from "@/lib/env"

const SERVICE_ID = "sapb1chat"

// POST binding: el token SSO llega en el body del form (nunca en la URL), enviado
// por el form auto-submit de /api/handoff de Mission Control. El receptor estándar
// de @ai4u/mc-sso valida el token, emite la cookie `mc_session` (8 h) y responde
// 303 → "/" (401 token inválido, 500 sin secreto — sin exponer el motivo).
export const POST = withApiHandler(
  createMcAuthHandler({
    serviceId:  SERVICE_ID,
    getSecret:  () => readEnv("MISSION_CONTROL_SECRET"),
    ttlMs:      SESSION_TTL_MS,
    redirectTo: "/",
    cookieName: COOKIE,
  }),
  { label: "POST mc-auth" },
) as (req: Request) => Promise<Response>
