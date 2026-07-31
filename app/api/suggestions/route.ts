import { withApiHandler } from "@ai4u/platform/http"
import { generateText, Output } from "ai"
import { z } from "zod"
import { getTenantProfile } from "@/lib/chat/tenant-profiles"
import { getTenantBackend } from "@/lib/tenant-backends"
import { getApiKey, getTenantId } from "@/app/lib/session"
import { verifyInternalSecret } from "@/lib/internal-auth"
import { MODELS } from "@/lib/chat/models"

// ─── /api/suggestions ────────────────────────────────────────────────────────
// Genera 4 preguntas estratégicas de negocio para el tenant activo mediante una
// llamada directa a Anthropic (Haiku, barato) con salida estructurada.
//
// POST { tenantName?: string }  (auth por sesión o x-internal-secret de Mission Control)
// → { questions: string[], generatedAt: number, source: "llm" | "fallback" | "static" }
// ─────────────────────────────────────────────────────────────────────────────

export const maxDuration = 30

const FALLBACK: string[] = [
  "¿Cómo van las ventas de este mes?",
  "¿Qué clientes me deben más?",
  "¿Qué productos dejan más margen?",
  "¿Qué materiales están por agotarse?",
]

const MAGDALENA_SUGGESTIONS: string[] = [
  "¿Cómo van los ingresos este año?",
  "¿Cómo atraemos nuevos coleccionistas?",
  "¿Cómo crecemos sin perder exclusividad?",
  "¿Qué mercados deberíamos explorar?",
]

function buildPrompt(today: string, tenantId: string, tenantNameFallback: string): string {
  let contexto = `La empresa es ${tenantNameFallback}.`
  try {
    const p = getTenantProfile(tenantId)
    contexto =
      `Empresa: ${p.nombre}\n` +
      `Industria: ${p.industria}\n` +
      `Líneas de negocio: ${p.lineasNegocio.join(", ")}\n` +
      `País: ${p.pais} · Moneda: ${p.moneda}`
  } catch {
    /* tenant sin perfil — usa el nombre tal cual */
  }

  return `Eres un consultor estratégico con expertise en SAP Business One.

${contexto}

Genera 4 preguntas cortas y fundamentales que el dueño debería hacerle hoy (${today}) al sistema SAP B1.

Cubre exactamente estas categorías, una por pregunta:
1. FINANZAS
2. CLIENTES Y VENTAS
3. OPERACIONES
4. ESTRATEGIA

Criterios:
- Máximo 10 palabras por pregunta. Directas, sin rodeos.
- Fundamentales: lo primero que un dueño quiere saber de su negocio.
- Lenguaje simple, sin jerga técnica ni condiciones compuestas.
- Respondibles con datos reales de SAP B1.

Ejemplos del estilo esperado: "¿Cómo van las ventas de este mes?", "¿Qué clientes me deben más?", "¿Qué productos dejan más margen?".`
}

export const POST = withApiHandler(async (req: Request) => {
  const body = await req.json().catch(() => ({}))

  // Auth: x-internal-secret de Mission Control, o sesión directa
  const internalSecret = req.headers.get("x-internal-secret")
  const isInternal = verifyInternalSecret(internalSecret)

  const apiKey   = isInternal ? req.headers.get("x-api-key")   : await getApiKey()
  const tenantId = isInternal ? req.headers.get("x-tenant-id") : await getTenantId()

  if (!apiKey || !tenantId) {
    return Response.json({ error: "Sesión no válida. Accede desde Mission Control." }, { status: 401 })
  }

  // Tenants no-SAP (proxy): sugerencias estáticas
  if (getTenantBackend(tenantId).type === "proxy") {
    return Response.json({ questions: MAGDALENA_SUGGESTIONS, generatedAt: Date.now(), source: "static" })
  }

  const { tenantName } = body as { tenantName?: string }
  const resolvedTenant = tenantName?.trim() || tenantId
  const today = new Date().toLocaleDateString("es-CO", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
    timeZone: "America/Bogota",
  })

  try {
    const { output } = await generateText({
      // Enrutado por Vercel AI Gateway (OIDC) — ver nota en app/api/chat/route.ts.
      model: MODELS["claude-haiku-4.5"].gatewaySlug,
      output: Output.object({
        schema: z.object({
          questions: z.array(z.string()).describe("Exactamente 4 preguntas estratégicas"),
        }),
      }),
      prompt: buildPrompt(today, tenantId, resolvedTenant),
      abortSignal: AbortSignal.timeout(25_000),
    })

    const questions = (output.questions ?? [])
      .map((q) => q.trim())
      .filter((q) => q.length >= 10)
      .slice(0, 4)

    if (questions.length === 0) {
      return Response.json({ questions: FALLBACK, generatedAt: Date.now(), source: "fallback" })
    }
    return Response.json({ questions, generatedAt: Date.now(), source: "llm" })
  } catch {
    return Response.json({ questions: FALLBACK, generatedAt: Date.now(), source: "fallback" })
  }
}, { label: "POST suggestions" }) as (req: Request) => Promise<Response>
