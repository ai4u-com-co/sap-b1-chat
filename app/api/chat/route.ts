import { createAnthropic } from "@ai-sdk/anthropic"
import { withApiHandler } from "@ai4u/platform/http"
import { supabase } from "@/lib/supabase"
import {
  streamText, stepCountIs, pruneMessages,
  createUIMessageStream, createUIMessageStreamResponse,
  convertToModelMessages,
  tool,
} from "ai"
import { z } from "zod"
import type { UIMessage, ModelMessage, UIMessageStreamWriter } from "ai"
import { getTenantId, getApiKey } from "@/app/lib/session"
import { resolveModelConfig, calculateCostWithCacheForModel } from "@/lib/chat/models"
import { verifyInternalSecret, getOutgoingInternalSecret } from "@/lib/internal-auth"

function resolveAuth(req: Request): { tenantId: string; sapApiKey: string; userId?: string } | null {
  const secret = req.headers.get("x-internal-secret")
  if (verifyInternalSecret(secret)) {
    const tenantId = req.headers.get("x-tenant-id")
    const sapApiKey = req.headers.get("x-api-key")
    const userId = req.headers.get("x-user-id") || undefined
    if (tenantId && sapApiKey) return { tenantId, sapApiKey, userId }
  }
  return null
}
import { BackendClient } from "@/lib/backend-client"
import { ENTITY_MAP } from "@ai4u/contracts"
import { buildStaticSystemPrompt, buildSapContextSection, buildFechaActual, type CatalogEntry } from "@/lib/chat/system-prompt"
import { fetchSapContext } from "@/lib/chat/sap-context"
import { getTenantBackend } from "@/lib/tenant-backends"

export const maxDuration = 300

// ── Proxy handler for non-SAP tenants ───────────────────────────
async function proxyToBackend(url: string, messages: unknown[], model?: string): Promise<Response> {
  if (!url) {
    return Response.json({ error: "Backend no configurado para este tenant." }, { status: 503 })
  }
  const secret = getOutgoingInternalSecret()
  let upstream: Response
  try {
    upstream = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(secret ? { "x-internal-secret": secret } : {}),
      },
      body: JSON.stringify({ messages, model }),
      signal: AbortSignal.timeout(290_000),
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return Response.json({ error: `Backend no disponible: ${msg}` }, { status: 502 })
  }
  if (!upstream.ok || !upstream.body) {
    return Response.json({ error: "Error del backend externo." }, { status: upstream.status })
  }
  return new Response(upstream.body, {
    headers: {
      "Content-Type": upstream.headers.get("Content-Type") ?? "text/event-stream",
      "X-Accel-Buffering": "no",
    },
  })
}

// ── Error classifier ────────────────────────────────────────────
type SapError = { code: string; message: string; retryable: boolean }

function classifySapError(err: unknown): { error: SapError } {
  const msg = err instanceof Error ? err.message : String(err)
  if (msg.includes("timeout"))
    return { error: { code: "SAP_TIMEOUT", message: "SAP B1 no respondió en el tiempo esperado.", retryable: true } }
  if (msg.includes("401") || msg.toLowerCase().includes("login"))
    return { error: { code: "SAP_AUTH", message: "Sesión SAP expirada. Contacta al administrador.", retryable: false } }
  if (msg.includes("404"))
    return { error: { code: "SAP_NOT_FOUND", message: msg, retryable: false } }
  return { error: { code: "SAP_ERROR", message: msg, retryable: false } }
}

// ── OData URL builders ───────────────────────────────────────────
function buildDocUrl(entityKey: string, id: string, expand?: string, select?: string): string {
  const cfg = ENTITY_MAP[entityKey]
  const sapEntity = cfg?.sapEntity ?? entityKey
  const key = cfg?.keyType === "string" ? `('${encodeURIComponent(id)}')` : `(${id})`
  const parts: string[] = []
  if (expand) parts.push(`$expand=${expand}`)
  if (select) parts.push(`$select=${select}`)
  return `/${sapEntity}${key}${parts.length ? "?" + parts.join("&") : ""}`
}

function buildODataUrl(entityKey: string, query: Record<string, string>): string {
  const parts: string[] = []
  const top = Math.min(parseInt(query.top ?? "50", 10) || 50, 500)
  parts.push(`$top=${top}`)
  if (query.skip) parts.push(`$skip=${query.skip}`)
  const cfg = ENTITY_MAP[entityKey]
  const filters: string[] = []
  if (cfg?.defaultFilter) filters.push(cfg.defaultFilter)
  if (query.filter) filters.push(query.filter)
  if (filters.length) parts.push(`$filter=${filters.join(" and ")}`)
  const select = query.select || cfg?.selectDefault
  if (select) parts.push(`$select=${select}`)
  if (query.orderby) parts.push(`$orderby=${query.orderby}`)
  if (query.expand) parts.push(`$expand=${query.expand}`)
  const sapEntity = cfg?.sapEntity ?? entityKey
  return `/${sapEntity}?${parts.join("&")}`
}

// ── Keywords para selección de modelo ────────────────────────────
const complexReportKeywords = [
  "reporte","informe","kpi","comparar","facturacion","facturado",
  "mensual","semanal","semana","trimestre","evolucion","crecimiento",
  "ventas","compras","contabilidad","asiento","grafico","dashboard",
  "top","sql","query","analizar","analisis","consolidado","balance",
  "hacer","crear","actualizar","modificar",
  "margen","rentabilidad","porcentaje","ticket","conversion",
  "vencido","cartera","cobros","pareto","historial",
]

// ── CORE_TABLES pre-registradas ──────────────────────────────────
const CORE_TABLES = [
  "OINV","INV1","OITM","OITB","OCRD","OSLP","ORCT","RCT2",
  "ORDR","RDR1","OQUT","QUT1","OPOR","POR1","OIGN","IGN1","OWOR","WOR1",
]

// ── Handler principal ────────────────────────────────────────────
export const POST = withApiHandler(async (req: Request) => {
  const internal = resolveAuth(req)
  const tenantId = internal?.tenantId ?? await getTenantId()
  const apiKey   = internal?.sapApiKey ?? await getApiKey()
  const userId   = internal?.userId
  if (!tenantId || !apiKey) {
    return Response.json({ error: "Sesión no válida. Accede desde Mission Control." }, { status: 401 })
  }

  const body = await req.json().catch(() => null)
  if (!body || !Array.isArray(body.messages)) {
    return Response.json({ error: "Body inválido. Se esperaba { messages: [...] }" }, { status: 400 })
  }

  const tenantBackend = getTenantBackend(tenantId)
  if (tenantBackend.type === "proxy") {
    return proxyToBackend(tenantBackend.proxyUrl ?? "", body.messages, body.model as string | undefined)
  }

  const sessionId = body.sessionId as string | undefined

  let modelMessages: ModelMessage[]
  try {
    modelMessages = await convertToModelMessages(body.messages as UIMessage[])
  } catch {
    return Response.json({ error: "Formato de mensajes inválido." }, { status: 400 })
  }

  const client = new BackendClient(tenantId, apiKey)

  // Model selection
  const lastUserMsg = [...modelMessages].reverse().find((m) => m.role === "user")
  const userContent = lastUserMsg?.content
  const userText = typeof userContent === "string"
    ? userContent
    : Array.isArray(userContent)
      ? userContent.filter((p) => p.type === "text").map((p) => (p as { type: "text"; text: string }).text).join(" ")
      : ""
  const userTextNorm = userText.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
  const isComplexQuery = complexReportKeywords.some((kw) => userTextNorm.includes(kw))

  // Resolución segura de modelo + effort + thinking (clampea al set válido del
  // modelo, nunca produce un 400). El cliente puede pedir cualquier modelo/effort.
  const requestedModel = typeof body.model === "string" ? body.model : ""
  const requestedEffort = typeof body.effort === "string" ? body.effort : undefined
  const { model: modelCap, effort, thinking } = resolveModelConfig(requestedModel, requestedEffort)
  const selectedModel = modelCap.id
  const maxSteps = isComplexQuery ? 20 : 12

  // Message pruning (no sessions — historial viene del cliente)
  const pruned = pruneMessages({
    messages: modelMessages,
    reasoning: "before-last-message",
    toolCalls: "before-last-3-messages",
    emptyMessages: "remove",
  })
  const allMessages = pruned.length > 60 ? pruned.slice(pruned.length - 60) : pruned

  // discoveredTables — estado por request
  const discoveredTables = new Set<string>(CORE_TABLES)

  // Anthropic key per tenant
  const anthropicKey =
    process.env[`${tenantId.toUpperCase()}_ANTHROPIC_API_KEY`] ??
    process.env.ANTHROPIC_API_KEY ??
    ""

  const anthropic = createAnthropic({ apiKey: anthropicKey })

  let writer!: UIMessageStreamWriter

  const stream = createUIMessageStream({
    execute: async (ctx) => {
      writer = ctx.writer
      writer.write({ type: "data-status", data: { text: "Conectando a SAP B1…" } } as never)
      const [sapCtx, catalogResult] = await Promise.all([
        fetchSapContext(client, tenantId),
        client.catalogList().catch(() => null),
      ])
      writer.write({ type: "data-status", data: { text: "Analizando tu consulta…" } } as never)

      const catalogEntries: CatalogEntry[] | undefined = catalogResult?.queries?.map(
        (q) => ({ name: q.name, description: q.description })
      )

      // ── System prompt cacheable ──────────────────────────────────
      // Bloque estático + datos maestros SAP: idéntico entre requests del
      // mismo tenant → cache_control ephemeral (1h). El breakpoint va al final
      // de este bloque, por lo que Anthropic cachea tools + system completos.
      // La fecha (única parte volátil) va en un bloque APARTE sin cache.
      const maestros = buildSapContextSection(sapCtx)
      const staticBlock = maestros
        ? `${buildStaticSystemPrompt(tenantId, catalogEntries)}\n\n${maestros}`
        : buildStaticSystemPrompt(tenantId, catalogEntries)

      const systemMessages: ModelMessage[] = [
        {
          role: "system",
          content: staticBlock,
          providerOptions: { anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } } },
        },
        { role: "system", content: buildFechaActual() },
      ]

      const result = streamText({
        model: anthropic(modelCap.apiSlug),
        messages: [...systemMessages, ...allMessages],
        stopWhen: stepCountIs(maxSteps),
        onFinish: async ({ text, toolCalls, toolResults }) => {
          if (supabase && sessionId && userId) {
            // Upsert session
            const title = userText.length > 44 ? userText.slice(0, 43) + "…" : userText || "Nueva conversación"
            try {
              await supabase.from("chat_sessions").upsert({
                id: sessionId,
                tenant_id: tenantId,
                user_id: userId,
                title: title,
                updated_at: new Date().toISOString()
              }, { onConflict: "id" })
            } catch {}

            if (lastUserMsg) {
              try {
                await supabase.from("chat_messages").insert({
                  session_id: sessionId,
                  role: "user",
                  content: userContent
                })
              } catch {}
            }

            if (text || (toolCalls && toolCalls.length > 0)) {
              try {
                await supabase.from("chat_messages").insert({
                  session_id: sessionId,
                  role: "assistant",
                  content: text,
                  tool_calls: toolCalls,
                  tool_results: toolResults
                })
              } catch {}
            }
          }
        },
        // cacheControl NO va aquí (global) — se marca por-mensaje en systemMessages.
        // thinking/effort vienen ya resueltos y clampeados por resolveModelConfig.
        providerOptions: {
          anthropic: {
            ...(thinking ? { thinking } : {}),
            ...(effort ? { effort } : {}),
          },
        },
        tools: {
          descubrir_esquema: tool({
            description:
              "Busca la estructura de tablas del ERP: columnas, tipos de datos y descripciones. Úsalo SIEMPRE antes de formular o corregir cualquier consulta SQL para asegurar nombres de campos y tablas correctos.",
            inputSchema: z.object({
              terminoBusqueda: z.string().describe("Nombre de la tabla (ej: 'OINV') o concepto (ej: 'cliente', 'factura')"),
            }),
            execute: async ({ terminoBusqueda }: { terminoBusqueda: string }, { toolCallId }) => {
              writer.write({ type: "data-tool-status", data: { toolCallId, text: `Buscando esquema de '${terminoBusqueda}'…` } } as never)
              try {
                const result = await client.schema(terminoBusqueda)
                discoveredTables.add(terminoBusqueda.trim().toUpperCase())
                for (const r of result.resultados as Array<{ tabla?: string }>) {
                  if (r.tabla) discoveredTables.add(r.tabla.toUpperCase())
                }
                return result
              } catch (err) {
                return classifySapError(err)
              }
            },
          }),

          consultar_sql: tool({
            description:
              "Ejecuta una consulta SQL SELECT en SAP Business One. Usa sintaxis SAP HANA. Solo lectura — no ejecutes INSERT, UPDATE, DELETE ni DROP.",
            inputSchema: z.object({
              sql: z.string().describe("Sentencia SQL SELECT en sintaxis HANA"),
            }),
            execute: async ({ sql }: { sql: string }, { toolCallId }) => {
              if (!sql.trim().toUpperCase().startsWith("SELECT")) {
                return { error: { code: "INVALID_QUERY", message: "Solo se permiten consultas SELECT.", retryable: false } }
              }
              const SQL_KEYWORDS = new Set([
                "ORDER","OUTER","UNION","OVER","OFFSET","ONLY","INNER","CROSS",
                "GROUP","HAVING","WHERE","FROM","INTO","JOIN","LEFT","RIGHT","FULL","WITH",
              ])
              const tableMatches = sql.match(/\b(O[A-Z]{3,4}|[A-Z]{3}\d)\b/gi) ?? []
              const tablesInQuery = Array.from(new Set(tableMatches.map((t) => t.toUpperCase()).filter((t) => !SQL_KEYWORDS.has(t))))
              const undiscovered = tablesInQuery.filter((t) => !discoveredTables.has(t))
              if (undiscovered.length > 0) {
                return {
                  error: {
                    code: "SCHEMA_NOT_DISCOVERED",
                    message: `Antes de consultar [${undiscovered.join(", ")}], usa 'descubrir_esquema' para verificar su estructura.`,
                    retryable: true,
                  },
                }
              }
              writer.write({ type: "data-tool-status", data: { toolCallId, text: "Ejecutando consulta SQL en SAP…" } } as never)
              try {
                const result = await client.sapQuery(sql)
                writer.write({ type: "data-tool-status", data: { toolCallId, text: `${result.count} registros procesados` } } as never)
                if (result.rows.length > 50) {
                  return {
                    rows: result.rows.slice(0, 20),
                    count: result.count,
                    truncated: true,
                    nota: `Se recibieron ${result.count} registros. Se muestran los primeros 20. Añade TOP N o refina el filtro.`,
                  }
                }
                return { rows: result.rows, count: result.count }
              } catch (err) {
                return classifySapError(err)
              }
            },
          }),

          ejecutar_query_catalogo: tool({
            description:
              "Ejecuta una query estándar del catálogo por nombre. Más seguro y rápido que consultar_sql para las 13 queries predefinidas. " +
              "Disponibles: ventas_por_periodo, top_clientes_por_facturacion, ventas_por_vendedor, " +
              "facturas_vencidas, aging_clientes, cobros_del_periodo, compras_por_proveedor, " +
              "pedidos_retrasados, margen_por_articulo, stock_por_almacen, items_sin_movimiento, " +
              "ops_abiertas, clientes_inactivos.",
            inputSchema: z.object({
              query: z.string().describe("Nombre exacto de la query del catálogo"),
              params: z.record(z.string(), z.unknown()).optional().describe("Parámetros de la query"),
              limit: z.number().int().min(1).max(5000).optional().describe("Máximo de filas (usa defaultLimit del catálogo si no se especifica)"),
            }),
            execute: async ({ query, params, limit }: { query: string; params?: Record<string, unknown>; limit?: number }, { toolCallId }) => {
              writer.write({ type: "data-tool-status", data: { toolCallId, text: `Ejecutando query '${query}'…` } } as never)
              try {
                const result = await client.catalogQuery(query, params, limit)
                writer.write({ type: "data-tool-status", data: { toolCallId, text: `${result.count} registros` } } as never)
                if (result.rows.length > 50) {
                  return {
                    rows: result.rows.slice(0, 30),
                    count: result.count,
                    truncated: true,
                    nota: `Se recibieron ${result.count} registros. Se muestran los primeros 30. Usa limit o parámetros de fecha para acotar.`,
                  }
                }
                return { rows: result.rows, count: result.count }
              } catch (err) {
                return classifySapError(err)
              }
            },
          }),

          listar_queries_catalogo: tool({
            description:
              "Lista todas las queries disponibles en el catálogo con sus parámetros. " +
              "Llamar cuando el usuario pregunte qué consultas están disponibles.",
            inputSchema: z.object({}),
            execute: async (_args: Record<string, never>, { toolCallId }) => {
              writer.write({ type: "data-tool-status", data: { toolCallId, text: "Cargando catálogo de queries…" } } as never)
              try {
                return await client.catalogList()
              } catch (err) {
                return classifySapError(err)
              }
            },
          }),

          obtener_documento: tool({
            description:
              "Obtiene el detalle completo de un documento de negocio por su ID. Incluye líneas si se pasa expand='DocumentLines'. " +
              "Dominios: ventas/pedidos, ventas/facturas, compras/ordenes, inventario/items, socios/clientes, socios/proveedores.",
            inputSchema: z.object({
              endpoint: z.string().describe("Dominio sin tenant. Ej: 'ventas/pedidos', 'inventario/items'"),
              id: z.string().describe("DocEntry numérico o código string"),
              expand: z.string().optional().describe("Ej: 'DocumentLines'"),
              select: z.string().optional().describe("Campos separados por coma"),
            }),
            execute: async ({ endpoint, id, expand, select }: { endpoint: string; id: string; expand?: string; select?: string }, { toolCallId }) => {
              const entityKey = endpoint.replace(/^\//, "")
              if (!ENTITY_MAP[entityKey]) {
                return { error: { code: "INVALID_ENDPOINT", message: `Endpoint '${endpoint}' no reconocido. Válidos: ${Object.keys(ENTITY_MAP).join(", ")}`, retryable: false } }
              }
              writer.write({ type: "data-tool-status", data: { toolCallId, text: `Obteniendo documento ${id}…` } } as never)
              try {
                const odataPath = buildDocUrl(entityKey, id, expand, select)
                const data = await client.odata<unknown>(odataPath)
                return { document: data }
              } catch (err) {
                return classifySapError(err)
              }
            },
          }),

          listar_registros: tool({
            description:
              "Lista documentos de negocio con filtros: pedidos, facturas, órdenes de compra, clientes, inventario. " +
              "Dominios: ventas/pedidos, ventas/facturas, ventas/cotizaciones, compras/ordenes, inventario/items, socios/clientes, socios/proveedores, pagos/cobros.",
            inputSchema: z.object({
              endpoint: z.string().describe("Ruta sin tenant. Ej: 'ventas/facturas'"),
              filter: z.string().optional().describe("Filtro OData. Ej: \"DocDate ge '2026-05-01'\""),
              select: z.string().optional(),
              top: z.string().optional().describe("Máximo resultados (1–500, default 50)"),
              skip: z.string().optional(),
              orderby: z.string().optional(),
              expand: z.string().optional(),
            }),
            execute: async (
              { endpoint, filter, select, top, skip, orderby, expand }:
              { endpoint: string; filter?: string; select?: string; top?: string; skip?: string; orderby?: string; expand?: string },
              { toolCallId }
            ) => {
              const entityKey = endpoint.replace(/^\//, "")
              if (!ENTITY_MAP[entityKey]) {
                return { error: { code: "INVALID_ENDPOINT", message: `Endpoint '${endpoint}' no reconocido.`, retryable: false } }
              }
              const query = Object.fromEntries(
                Object.entries({ filter, select, top, skip, orderby, expand }).filter(([, v]) => v !== undefined) as [string, string][]
              )
              writer.write({ type: "data-tool-status", data: { toolCallId, text: `Consultando ${entityKey}…` } } as never)
              try {
                const odataPath = buildODataUrl(entityKey, query)
                const data = await client.odata<{ value?: unknown[] }>(odataPath)
                const rows = data.value ?? []
                writer.write({ type: "data-tool-status", data: { toolCallId, text: `${rows.length} registros encontrados` } } as never)
                return { rows, count: rows.length }
              } catch (err) {
                return classifySapError(err)
              }
            },
          }),

          buscar_socio_o_item: tool({
            description:
              "Busca clientes, proveedores o artículos por nombre o código parcial. " +
              "Preferir sobre listar_registros cuando la intención es identificar una entidad por texto.",
            inputSchema: z.object({
              tipo: z.enum(["cliente", "proveedor", "item"]).describe("Tipo de entidad"),
              texto: z.string().describe("Texto parcial a buscar"),
              top: z.number().optional().describe("Máximo resultados (default 10)"),
            }),
            execute: async ({ tipo, texto, top }: { tipo: "cliente" | "proveedor" | "item"; texto: string; top?: number }, { toolCallId }) => {
              writer.write({ type: "data-tool-status", data: { toolCallId, text: `Buscando ${tipo}…` } } as never)
              const limit = Math.min(top ?? 10, 50)
              const safeTexto = texto.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 100)
              const escaped = safeTexto.replace(/'/g, "''")
              try {
                if (tipo === "item") {
                  const path = `/Items?$select=ItemCode,ItemName,AvgStdPrice,QuantityOnStock&$top=${limit}&$filter=contains(ItemCode,'${escaped}') or contains(ItemName,'${escaped}')`
                  const res = await client.odata<{ value?: unknown[] }>(path)
                  return { resultados: res.value ?? [], count: (res.value ?? []).length }
                }
                const cardFilter = tipo === "cliente" ? "CardType eq 'cCustomer'" : "CardType eq 'cSupplier'"
                const path = `/BusinessPartners?$select=CardCode,CardName,Phone1,EmailAddress,CurrentAccountBalance&$top=${limit}&$filter=(${cardFilter}) and (contains(CardCode,'${escaped}') or contains(CardName,'${escaped}'))`
                const res = await client.odata<{ value?: unknown[] }>(path)
                return { resultados: res.value ?? [], count: (res.value ?? []).length }
              } catch (err) {
                return classifySapError(err)
              }
            },
          }),

          perfil_cliente: tool({
            description: "Perfil completo de un cliente: datos de contacto, saldo, crédito disponible, facturas vencidas, último pedido. Requiere CardCode exacto.",
            inputSchema: z.object({
              cardCode: z.string().describe("Código exacto del cliente (CardCode)"),
              modo: z.enum(["balance", "resumen_completo"]).default("resumen_completo"),
            }),
            execute: async ({ cardCode, modo }: { cardCode: string; modo: "balance" | "resumen_completo" }, { toolCallId }) => {
              writer.write({ type: "data-tool-status", data: { toolCallId, text: `Consultando perfil de ${cardCode}…` } } as never)
              try {
                const path = modo === "balance" ? `/customers/${cardCode}/balance` : `/customers/${cardCode}/summary`
                const data = await client.get<unknown>(path)
                return { [modo === "balance" ? "balance" : "summary"]: data }
              } catch (err) { return classifySapError(err) }
            },
          }),

          historial_cliente: tool({
            description: "Historial de compras de un cliente: productos habituales, frecuencia y gasto total. Requiere CardCode exacto.",
            inputSchema: z.object({
              cardCode: z.string(),
              meses: z.number().int().min(1).max(36).default(12),
              topN: z.number().int().min(1).max(50).default(10),
            }),
            execute: async ({ cardCode, meses, topN }: { cardCode: string; meses: number; topN: number }, { toolCallId }) => {
              writer.write({ type: "data-tool-status", data: { toolCallId, text: `Analizando historial de ${cardCode}…` } } as never)
              try {
                const data = await client.get<unknown>(`/customers/${cardCode}/history?months=${meses}&topN=${topN}`)
                return { history: data }
              } catch (err) { return classifySapError(err) }
            },
          }),

          aging_cliente: tool({
            description: "Facturas vencidas de un cliente específico con aging por tramos. Para aging global usar cartera_empresa.",
            inputSchema: z.object({ cardCode: z.string() }),
            execute: async ({ cardCode }: { cardCode: string }, { toolCallId }) => {
              writer.write({ type: "data-tool-status", data: { toolCallId, text: `Consultando facturas vencidas de ${cardCode}…` } } as never)
              try {
                const data = await client.get<unknown>(`/customers/${cardCode}/aging`)
                return { aging: data }
              } catch (err) { return classifySapError(err) }
            },
          }),

          verificar_credito: tool({
            description: "Crédito de un cliente antes de crear un pedido: saldo, límite, comprometido, disponible y estado (ok/warning/blocked).",
            inputSchema: z.object({ cardCode: z.string() }),
            execute: async ({ cardCode }: { cardCode: string }, { toolCallId }) => {
              writer.write({ type: "data-tool-status", data: { toolCallId, text: `Verificando crédito de ${cardCode}…` } } as never)
              try {
                const data = await client.get<unknown>(`/customers/${cardCode}/credit-check`)
                return { credit: data }
              } catch (err) { return classifySapError(err) }
            },
          }),

          pagos_cliente: tool({
            description: "Historial de pagos recibidos de un cliente: fechas, montos y forma de pago.",
            inputSchema: z.object({
              cardCode: z.string(),
              limite: z.number().int().min(1).max(200).default(50),
            }),
            execute: async ({ cardCode, limite }: { cardCode: string; limite: number }, { toolCallId }) => {
              writer.write({ type: "data-tool-status", data: { toolCallId, text: `Consultando pagos de ${cardCode}…` } } as never)
              try {
                const data = await client.get<unknown>(`/customers/${cardCode}/payments?limit=${limite}`)
                return { result: data }
              } catch (err) { return classifySapError(err) }
            },
          }),

          clientes_inactivos: tool({
            description: "Clientes que no han comprado en los últimos N meses, ordenados por días sin actividad.",
            inputSchema: z.object({
              meses: z.number().int().min(1).max(24).default(3),
              limite: z.number().int().min(1).max(200).default(50),
            }),
            execute: async ({ meses, limite }: { meses: number; limite: number }, { toolCallId }) => {
              writer.write({ type: "data-tool-status", data: { toolCallId, text: `Buscando clientes sin compras en ${meses} meses…` } } as never)
              try {
                const data = await client.get<unknown>(`/customers/churn?months=${meses}&limit=${limite}`)
                return { result: data }
              } catch (err) { return classifySapError(err) }
            },
          }),

          pipeline_ventas: tool({
            description: "Snapshot del pipeline: cotizaciones y pedidos abiertos con montos. Opcionalmente filtrar por cardCode.",
            inputSchema: z.object({ cardCode: z.string().optional() }),
            execute: async ({ cardCode }: { cardCode?: string }, { toolCallId }) => {
              writer.write({ type: "data-tool-status", data: { toolCallId, text: "Consultando pipeline de ventas…" } } as never)
              try {
                const qs = cardCode ? `?cardCode=${cardCode}` : ""
                const data = await client.get<unknown>(`/sales/pipeline${qs}`)
                return { pipeline: data }
              } catch (err) { return classifySapError(err) }
            },
          }),

          analisis_ventas: tool({
            description: "Análisis de ventas: top clientes por revenue, top productos, totales del período.",
            inputSchema: z.object({
              desde: z.string().optional(),
              hasta: z.string().optional(),
              topN: z.number().int().min(1).max(50).default(10),
            }),
            execute: async ({ desde, hasta, topN }: { desde?: string; hasta?: string; topN: number }, { toolCallId }) => {
              writer.write({ type: "data-tool-status", data: { toolCallId, text: "Analizando ventas del período…" } } as never)
              try {
                const parts = [`topN=${topN}`]
                if (desde) parts.push(`from=${desde}`)
                if (hasta) parts.push(`to=${hasta}`)
                const data = await client.get<unknown>(`/sales/analysis?${parts.join("&")}`)
                return { analysis: data }
              } catch (err) { return classifySapError(err) }
            },
          }),

          tendencia_ventas: tool({
            description: "Ventas mes a mes últimos 12 meses con variación MoM y YoY.",
            inputSchema: z.object({}),
            execute: async (_args: Record<string, never>, { toolCallId }) => {
              writer.write({ type: "data-tool-status", data: { toolCallId, text: "Calculando tendencia de ventas 12 meses…" } } as never)
              try {
                const data = await client.get<unknown>("/sales/trend")
                return { trend: data }
              } catch (err) { return classifySapError(err) }
            },
          }),

          pedidos_retrasados: tool({
            description: "Pedidos de venta con fecha de entrega vencida, ordenados por días de retraso.",
            inputSchema: z.object({ limite: z.number().int().min(1).max(200).default(50) }),
            execute: async ({ limite }: { limite: number }, { toolCallId }) => {
              writer.write({ type: "data-tool-status", data: { toolCallId, text: "Consultando pedidos con entrega vencida…" } } as never)
              try {
                const data = await client.get<unknown>(`/sales/delayed?limit=${limite}`)
                return { result: data }
              } catch (err) { return classifySapError(err) }
            },
          }),

          listar_pedidos: tool({
            description: "Lista pedidos de venta con filtros por cliente, estado y fechas.",
            inputSchema: z.object({
              cardCode: z.string().optional(),
              estado: z.enum(["O", "C"]).optional(),
              desde: z.string().optional(),
              hasta: z.string().optional(),
              limite: z.number().int().min(1).max(500).default(50),
            }),
            execute: async ({ cardCode, estado, desde, hasta, limite }: { cardCode?: string; estado?: "O" | "C"; desde?: string; hasta?: string; limite: number }, { toolCallId }) => {
              writer.write({ type: "data-tool-status", data: { toolCallId, text: "Consultando pedidos de venta…" } } as never)
              try {
                const parts = [`limit=${limite}`]
                if (cardCode) parts.push(`cardCode=${cardCode}`)
                if (estado) parts.push(`status=${estado}`)
                if (desde) parts.push(`from=${desde}`)
                if (hasta) parts.push(`to=${hasta}`)
                const data = await client.get<unknown>(`/sales/orders?${parts.join("&")}`)
                return { result: data }
              } catch (err) { return classifySapError(err) }
            },
          }),

          detalle_pedido: tool({
            description: "Detalle completo de un pedido de venta por DocEntry: encabezado + líneas.",
            inputSchema: z.object({ docEntry: z.number().int().positive() }),
            execute: async ({ docEntry }: { docEntry: number }, { toolCallId }) => {
              writer.write({ type: "data-tool-status", data: { toolCallId, text: `Obteniendo pedido DocEntry ${docEntry}…` } } as never)
              try {
                const data = await client.get<unknown>(`/sales/orders/${docEntry}`)
                return { order: data }
              } catch (err) { return classifySapError(err) }
            },
          }),

          analisis_cotizaciones: tool({
            description: "Pipeline comercial de cotizaciones: tasa de conversión, tiempo promedio de cierre, monto abierto.",
            inputSchema: z.object({ desde: z.string().optional(), hasta: z.string().optional() }),
            execute: async ({ desde, hasta }: { desde?: string; hasta?: string }, { toolCallId }) => {
              writer.write({ type: "data-tool-status", data: { toolCallId, text: "Analizando pipeline de cotizaciones…" } } as never)
              try {
                const parts: string[] = []
                if (desde) parts.push(`from=${desde}`)
                if (hasta) parts.push(`to=${hasta}`)
                const data = await client.get<unknown>(`/commercial/quotations${parts.length ? "?" + parts.join("&") : ""}`)
                return { result: data }
              } catch (err) { return classifySapError(err) }
            },
          }),

          clientes_nuevos: tool({
            description: "Clientes con su primera compra en el período indicado.",
            inputSchema: z.object({
              desde: z.string().optional(),
              hasta: z.string().optional(),
              limite: z.number().int().min(1).max(200).default(50),
            }),
            execute: async ({ desde, hasta, limite }: { desde?: string; hasta?: string; limite: number }, { toolCallId }) => {
              writer.write({ type: "data-tool-status", data: { toolCallId, text: "Buscando clientes con primera compra…" } } as never)
              try {
                const parts = [`limit=${limite}`]
                if (desde) parts.push(`from=${desde}`)
                if (hasta) parts.push(`to=${hasta}`)
                const data = await client.get<unknown>(`/commercial/new-customers?${parts.join("&")}`)
                return { result: data }
              } catch (err) { return classifySapError(err) }
            },
          }),

          ventas_por_categoria: tool({
            description: "Ventas del período desglosadas por categoría/grupo de producto con % de participación.",
            inputSchema: z.object({ desde: z.string().optional(), hasta: z.string().optional() }),
            execute: async ({ desde, hasta }: { desde?: string; hasta?: string }, { toolCallId }) => {
              writer.write({ type: "data-tool-status", data: { toolCallId, text: "Calculando ventas por categoría…" } } as never)
              try {
                const parts: string[] = []
                if (desde) parts.push(`from=${desde}`)
                if (hasta) parts.push(`to=${hasta}`)
                const data = await client.get<unknown>(`/commercial/sales-by-group${parts.length ? "?" + parts.join("&") : ""}`)
                return { result: data }
              } catch (err) { return classifySapError(err) }
            },
          }),

          disponibilidad_inventario: tool({
            description: "Stock disponible de un artículo por almacén: existencias, comprometidas y libres para vender.",
            inputSchema: z.object({
              itemCode: z.string(),
              almacen: z.string().optional(),
            }),
            execute: async ({ itemCode, almacen }: { itemCode: string; almacen?: string }, { toolCallId }) => {
              writer.write({ type: "data-tool-status", data: { toolCallId, text: `Consultando stock de ${itemCode}…` } } as never)
              try {
                const qs = almacen ? `?almacen=${almacen}` : ""
                const data = await client.get<unknown>(`/inventory/${itemCode}/availability${qs}`)
                return { availability: data }
              } catch (err) { return classifySapError(err) }
            },
          }),

          stock_critico: tool({
            description: "Artículos por debajo del punto de reorden mínimo. Opcionalmente filtrar por almacén.",
            inputSchema: z.object({ almacen: z.string().optional() }),
            execute: async ({ almacen }: { almacen?: string }, { toolCallId }) => {
              writer.write({ type: "data-tool-status", data: { toolCallId, text: "Consultando artículos bajo stock mínimo…" } } as never)
              try {
                const qs = almacen ? `?almacen=${almacen}` : ""
                const data = await client.get<{ items?: unknown[]; count?: number }>(`/inventory/low-stock${qs}`)
                return { items: data.items ?? data, count: data.count }
              } catch (err) { return classifySapError(err) }
            },
          }),

          movimientos_inventario: tool({
            description: "Historial de entradas y salidas de un artículo en los últimos N días.",
            inputSchema: z.object({
              itemCode: z.string(),
              dias: z.number().int().min(1).max(365).default(30),
              almacen: z.string().optional(),
            }),
            execute: async ({ itemCode, dias, almacen }: { itemCode: string; dias: number; almacen?: string }, { toolCallId }) => {
              writer.write({ type: "data-tool-status", data: { toolCallId, text: `Consultando movimientos de ${itemCode}…` } } as never)
              try {
                const parts = [`days=${dias}`]
                if (almacen) parts.push(`warehouseCode=${almacen}`)
                const data = await client.get<unknown>(`/inventory/${itemCode}/movements?${parts.join("&")}`)
                return { movements: data }
              } catch (err) { return classifySapError(err) }
            },
          }),

          detalle_producto: tool({
            description: "Ficha completa de un producto: descripción, stock por almacén y precios por lista.",
            inputSchema: z.object({ itemCode: z.string() }),
            execute: async ({ itemCode }: { itemCode: string }, { toolCallId }) => {
              writer.write({ type: "data-tool-status", data: { toolCallId, text: `Cargando ficha de ${itemCode}…` } } as never)
              try {
                const data = await client.get<unknown>(`/products/${itemCode}`)
                return { product: data }
              } catch (err) { return classifySapError(err) }
            },
          }),

          buscar_productos: tool({
            description: "Busca productos por nombre o código parcial con stock y precio base.",
            inputSchema: z.object({
              texto: z.string(),
              limite: z.number().int().min(1).max(100).default(20),
            }),
            execute: async ({ texto, limite }: { texto: string; limite: number }, { toolCallId }) => {
              writer.write({ type: "data-tool-status", data: { toolCallId, text: `Buscando productos '${texto}'…` } } as never)
              try {
                const data = await client.get<unknown>(`/products/search?q=${encodeURIComponent(texto)}&limit=${limite}`)
                return { results: data }
              } catch (err) { return classifySapError(err) }
            },
          }),

          cartera_empresa: tool({
            description: "Análisis de cuentas por cobrar (clientes) o cuentas por pagar (proveedores) con aging en tramos de días.",
            inputSchema: z.object({
              tipo: z.enum(["cuentas_por_cobrar", "cuentas_por_pagar"]),
            }),
            execute: async ({ tipo }: { tipo: "cuentas_por_cobrar" | "cuentas_por_pagar" }, { toolCallId }) => {
              const label = tipo === "cuentas_por_cobrar" ? "cuentas por cobrar" : "cuentas por pagar"
              writer.write({ type: "data-tool-status", data: { toolCallId, text: `Analizando ${label}…` } } as never)
              try {
                const path = tipo === "cuentas_por_cobrar" ? "/finance/receivables" : "/finance/payables"
                const data = await client.get<unknown>(path)
                return { [tipo]: data }
              } catch (err) { return classifySapError(err) }
            },
          }),

          flujo_caja: tool({
            description: "Proyección de flujo de caja a 90 días: cobros esperados vs pagos comprometidos en ventanas de 30 días.",
            inputSchema: z.object({}),
            execute: async (_args: Record<string, never>, { toolCallId }) => {
              writer.write({ type: "data-tool-status", data: { toolCallId, text: "Calculando proyección de flujo de caja 90 días…" } } as never)
              try {
                const data = await client.get<unknown>("/finance/cashflow")
                return { cashflow: data }
              } catch (err) { return classifySapError(err) }
            },
          }),

          ordenes_compra: tool({
            description: "Lista órdenes de compra con filtros: por proveedor, estado y fechas.",
            inputSchema: z.object({
              cardCode: z.string().optional(),
              estado: z.enum(["O", "C"]).optional(),
              desde: z.string().optional(),
              hasta: z.string().optional(),
              limite: z.number().int().min(1).max(500).default(50),
            }),
            execute: async ({ cardCode, estado, desde, hasta, limite }: { cardCode?: string; estado?: "O" | "C"; desde?: string; hasta?: string; limite: number }, { toolCallId }) => {
              writer.write({ type: "data-tool-status", data: { toolCallId, text: "Consultando órdenes de compra…" } } as never)
              try {
                const parts = [`limit=${limite}`]
                if (cardCode) parts.push(`cardCode=${cardCode}`)
                if (estado) parts.push(`status=${estado}`)
                if (desde) parts.push(`from=${desde}`)
                if (hasta) parts.push(`to=${hasta}`)
                const data = await client.get<unknown>(`/purchasing/orders?${parts.join("&")}`)
                return { result: data }
              } catch (err) { return classifySapError(err) }
            },
          }),

          detalle_orden_compra: tool({
            description: "Detalle completo de una orden de compra: proveedor, artículos pedidos, cantidades recibidas y pendientes.",
            inputSchema: z.object({ docEntry: z.number().int().positive() }),
            execute: async ({ docEntry }: { docEntry: number }, { toolCallId }) => {
              writer.write({ type: "data-tool-status", data: { toolCallId, text: `Cargando OC DocEntry ${docEntry}…` } } as never)
              try {
                const data = await client.get<unknown>(`/purchasing/orders/${docEntry}`)
                return { result: data }
              } catch (err) { return classifySapError(err) }
            },
          }),

          ordenes_produccion: tool({
            description: "Órdenes de producción abiertas (Planificadas y Liberadas) con progreso y fecha de vencimiento.",
            inputSchema: z.object({
              itemCode: z.string().optional(),
              limite: z.number().int().min(1).max(500).default(100),
            }),
            execute: async ({ itemCode, limite }: { itemCode?: string; limite: number }, { toolCallId }) => {
              writer.write({ type: "data-tool-status", data: { toolCallId, text: "Consultando órdenes de producción abiertas…" } } as never)
              try {
                const parts = [`limit=${limite}`]
                if (itemCode) parts.push(`itemCode=${itemCode}`)
                const data = await client.get<unknown>(`/production/orders?${parts.join("&")}`)
                return { result: data }
              } catch (err) { return classifySapError(err) }
            },
          }),

          detalle_orden_produccion: tool({
            description: "Detalle completo de una orden de producción: artículo terminado, componentes y cantidades.",
            inputSchema: z.object({ docEntry: z.number().int().positive() }),
            execute: async ({ docEntry }: { docEntry: number }, { toolCallId }) => {
              writer.write({ type: "data-tool-status", data: { toolCallId, text: `Cargando OP DocEntry ${docEntry}…` } } as never)
              try {
                const data = await client.get<unknown>(`/production/orders/${docEntry}`)
                return { result: data }
              } catch (err) { return classifySapError(err) }
            },
          }),

          faltantes_produccion: tool({
            description: "Componentes con stock insuficiente para completar las órdenes de producción abiertas.",
            inputSchema: z.object({}),
            execute: async (_args: Record<string, never>, { toolCallId }) => {
              writer.write({ type: "data-tool-status", data: { toolCallId, text: "Analizando faltantes de materiales…" } } as never)
              try {
                const data = await client.get<unknown>("/production/shortage")
                return { result: data }
              } catch (err) { return classifySapError(err) }
            },
          }),

          validar_y_crear_pedido: tool({
            description:
              "Flujo completo: verifica crédito + stock + crea el pedido. confirmar=false = reporte de validación. confirmar=true = crea si es viable.",
            inputSchema: z.object({
              cardCode: z.string(),
              lines: z.array(z.object({
                itemCode: z.string(),
                quantity: z.number().positive(),
                unitPrice: z.number().nonnegative().optional(),
                warehouseCode: z.string().optional(),
                discount: z.number().min(0).max(100).optional(),
              })).min(1),
              docDate: z.string().optional(),
              dueDate: z.string().optional(),
              comments: z.string().optional(),
              confirmar: z.boolean().default(false),
            }),
            execute: async ({ confirmar, ...header }: { confirmar: boolean; cardCode: string; lines: unknown[]; docDate?: string; dueDate?: string; comments?: string }, { toolCallId }) => {
              writer.write({ type: "data-tool-status", data: { toolCallId, text: `Validando pedido para ${header.cardCode}…` } } as never)
              if (!confirmar) return { preview: header, mensaje: "Vista previa del pedido. Confirma para validar crédito/stock y crear en SAP." }
              try {
                const data = await client.post<unknown>("/workflows/validate-and-create-order", { ...header, confirmar })
                return { result: data }
              } catch (err) { return classifySapError(err) }
            },
          }),

          reponer_faltantes: tool({
            description: "Detecta faltantes en producción y genera OCs por proveedor. confirmar=false = plan. confirmar=true = crea OCs.",
            inputSchema: z.object({
              defaultSupplier: z.string(),
              supplierByWarehouse: z.string().optional(),
              confirmar: z.boolean().default(false),
            }),
            execute: async ({ defaultSupplier, supplierByWarehouse, confirmar }: { defaultSupplier: string; supplierByWarehouse?: string; confirmar: boolean }, { toolCallId }) => {
              writer.write({ type: "data-tool-status", data: { toolCallId, text: "Analizando faltantes y generando plan…" } } as never)
              if (!confirmar) return { preview: { defaultSupplier, supplierByWarehouse }, mensaje: "Vista previa del plan de reposición. Confirma para crear las OCs en SAP." }
              try {
                const data = await client.post<unknown>("/workflows/replenish-shortages", { defaultSupplier, supplierByWarehouse, confirmar })
                return { result: data }
              } catch (err) { return classifySapError(err) }
            },
          }),

          facturar_pedido: tool({
            description: "Convierte un pedido de venta en factura. confirmar=false = preview. confirmar=true = crea en SAP.",
            inputSchema: z.object({
              docEntry: z.number().int().positive(),
              confirmar: z.boolean().default(false),
            }),
            execute: async ({ docEntry, confirmar }: { docEntry: number; confirmar: boolean }, { toolCallId }) => {
              writer.write({ type: "data-tool-status", data: { toolCallId, text: confirmar ? `Creando factura del pedido ${docEntry}…` : `Preparando factura del pedido ${docEntry}…` } } as never)
              try {
                const data = await client.post<unknown>("/workflows/order-to-invoice", { docEntry, confirmar })
                return { result: data }
              } catch (err) { return classifySapError(err) }
            },
          }),

          crear_pedido: tool({
            description: "Crea un pedido de venta. REGLA: llamar primero con confirmar=false para preview. Solo confirmar=true si el usuario aprobó.",
            inputSchema: z.object({
              cardCode: z.string(),
              lines: z.array(z.object({ itemCode: z.string(), quantity: z.number().positive(), unitPrice: z.number().nonnegative().optional(), warehouseCode: z.string().optional(), discount: z.number().min(0).max(100).optional() })).min(1),
              docDate: z.string().optional(),
              dueDate: z.string().optional(),
              comments: z.string().optional(),
              reference: z.string().optional(),
              confirmar: z.boolean().default(false),
            }),
            execute: async ({ confirmar, ...header }: { confirmar: boolean; cardCode: string; lines: unknown[]; docDate?: string; dueDate?: string; comments?: string; reference?: string }, { toolCallId }) => {
              writer.write({ type: "data-tool-status", data: { toolCallId, text: confirmar ? `Creando pedido para ${header.cardCode}…` : `Preparando pedido para ${header.cardCode}…` } } as never)
              if (!confirmar) return { preview: header, mensaje: "Vista previa. Confirma para crear en SAP." }
              try {
                const data = await client.post<unknown>("/sales/orders", header)
                return { result: data }
              } catch (err) { return classifySapError(err) }
            },
          }),

          cancelar_pedido: tool({
            description: "Cancela un pedido de venta abierto. Irreversible. REGLA: confirmar=false primero para advertencia.",
            inputSchema: z.object({
              docEntry: z.number().int().positive(),
              confirmar: z.boolean().default(false),
            }),
            execute: async ({ docEntry, confirmar }: { docEntry: number; confirmar: boolean }, { toolCallId }) => {
              writer.write({ type: "data-tool-status", data: { toolCallId, text: confirmar ? `Cancelando pedido ${docEntry}…` : `Preparando cancelación de pedido ${docEntry}…` } } as never)
              if (!confirmar) return { advertencia: `Se cancelará el pedido DocEntry ${docEntry}. Esta acción es irreversible. ¿Confirmas?` }
              try {
                const data = await client.post<unknown>(`/sales/orders/${docEntry}/cancel`, {})
                return { result: data }
              } catch (err) { return classifySapError(err) }
            },
          }),

          crear_cotizacion: tool({
            description: "Crea una cotización de venta. REGLA: confirmar=false primero.",
            inputSchema: z.object({
              cardCode: z.string(),
              lines: z.array(z.object({ itemCode: z.string(), quantity: z.number().positive(), unitPrice: z.number().nonnegative().optional(), warehouseCode: z.string().optional(), discount: z.number().min(0).max(100).optional() })).min(1),
              docDate: z.string().optional(),
              dueDate: z.string().optional(),
              comments: z.string().optional(),
              confirmar: z.boolean().default(false),
            }),
            execute: async ({ confirmar, ...header }: { confirmar: boolean; cardCode: string; lines: unknown[]; docDate?: string; dueDate?: string; comments?: string }, { toolCallId }) => {
              writer.write({ type: "data-tool-status", data: { toolCallId, text: confirmar ? `Creando cotización para ${header.cardCode}…` : `Preparando cotización para ${header.cardCode}…` } } as never)
              if (!confirmar) return { preview: header, mensaje: "Vista previa. Confirma para crear en SAP." }
              try {
                const data = await client.post<unknown>("/quotations", header)
                return { result: data }
              } catch (err) { return classifySapError(err) }
            },
          }),

          convertir_cotizacion: tool({
            description: "Convierte una cotización en pedido de venta. REGLA: confirmar=false primero.",
            inputSchema: z.object({
              docEntry: z.number().int().positive(),
              confirmar: z.boolean().default(false),
            }),
            execute: async ({ docEntry, confirmar }: { docEntry: number; confirmar: boolean }, { toolCallId }) => {
              writer.write({ type: "data-tool-status", data: { toolCallId, text: confirmar ? `Convirtiendo cotización ${docEntry}…` : `Preparando conversión de cotización ${docEntry}…` } } as never)
              if (!confirmar) return { advertencia: `Se convertirá la cotización DocEntry ${docEntry} en pedido. ¿Confirmas?` }
              try {
                const data = await client.post<unknown>(`/quotations/${docEntry}/convert`, {})
                return { result: data }
              } catch (err) { return classifySapError(err) }
            },
          }),

          crear_orden_compra: tool({
            description: "Crea una orden de compra a un proveedor. REGLA: confirmar=false primero.",
            inputSchema: z.object({
              cardCode: z.string(),
              lines: z.array(z.object({ itemCode: z.string(), quantity: z.number().positive(), unitPrice: z.number().nonnegative().optional(), warehouseCode: z.string().optional() })).min(1),
              docDate: z.string().optional(),
              dueDate: z.string().optional(),
              comments: z.string().optional(),
              reference: z.string().optional(),
              confirmar: z.boolean().default(false),
            }),
            execute: async ({ confirmar, ...header }: { confirmar: boolean; cardCode: string; lines: unknown[]; docDate?: string; dueDate?: string; comments?: string; reference?: string }, { toolCallId }) => {
              writer.write({ type: "data-tool-status", data: { toolCallId, text: confirmar ? `Creando OC para ${header.cardCode}…` : `Preparando OC para ${header.cardCode}…` } } as never)
              if (!confirmar) return { preview: header, mensaje: "Vista previa. Confirma para crear en SAP." }
              try {
                const data = await client.post<unknown>("/purchasing/orders", header)
                return { result: data }
              } catch (err) { return classifySapError(err) }
            },
          }),

          cancelar_orden_compra: tool({
            description: "Cancela una orden de compra abierta. Irreversible. REGLA: confirmar=false primero.",
            inputSchema: z.object({
              docEntry: z.number().int().positive(),
              confirmar: z.boolean().default(false),
            }),
            execute: async ({ docEntry, confirmar }: { docEntry: number; confirmar: boolean }, { toolCallId }) => {
              writer.write({ type: "data-tool-status", data: { toolCallId, text: confirmar ? `Cancelando OC ${docEntry}…` : `Preparando cancelación de OC ${docEntry}…` } } as never)
              if (!confirmar) return { advertencia: `Se cancelará la OC DocEntry ${docEntry}. Esta acción es irreversible. ¿Confirmas?` }
              try {
                const data = await client.post<unknown>(`/purchasing/orders/${docEntry}/cancel`, {})
                return { result: data }
              } catch (err) { return classifySapError(err) }
            },
          }),

          crear_orden_produccion: tool({
            description: "Crea una orden de producción. REGLA: confirmar=false primero.",
            inputSchema: z.object({
              itemCode: z.string(),
              plannedQty: z.number().positive(),
              dueDate: z.string().optional(),
              startDate: z.string().optional(),
              warehouseCode: z.string().optional(),
              comments: z.string().optional(),
              confirmar: z.boolean().default(false),
            }),
            execute: async ({ confirmar, ...payload }: { confirmar: boolean; itemCode: string; plannedQty: number; dueDate?: string; startDate?: string; warehouseCode?: string; comments?: string }, { toolCallId }) => {
              writer.write({ type: "data-tool-status", data: { toolCallId, text: confirmar ? `Creando OP para ${payload.itemCode}…` : `Preparando OP para ${payload.itemCode}…` } } as never)
              if (!confirmar) return { preview: payload, mensaje: "Vista previa. Confirma para crear en SAP." }
              try {
                const data = await client.post<unknown>("/production/orders", payload)
                return { result: data }
              } catch (err) { return classifySapError(err) }
            },
          }),

          crear_documento: tool({
            description: "Crea un documento de negocio genérico. REGLA: confirmar=false primero. Dominios: ventas/pedidos, ventas/cotizaciones, ventas/facturas, compras/ordenes.",
            inputSchema: z.object({
              endpoint: z.string().describe("Ej: 'compras/ordenes', 'ventas/cotizaciones'"),
              payload: z.string().describe("JSON del documento como string"),
              confirmar: z.boolean(),
            }),
            execute: async ({ endpoint, payload, confirmar }: { endpoint: string; payload: string; confirmar: boolean }, { toolCallId }) => {
              const entityKey = endpoint.replace(/^\//, "")
              const cfg = ENTITY_MAP[entityKey]
              if (!cfg) return { error: { code: "INVALID_ENDPOINT", message: `Endpoint '${endpoint}' no reconocido. Válidos: ${Object.keys(ENTITY_MAP).join(", ")}`, retryable: false } }
              let parsed: unknown
              try { parsed = JSON.parse(payload) } catch { return { error: { code: "INVALID_JSON", message: "El payload no es JSON válido.", retryable: false } } }
              if (!confirmar) return { preview: parsed, entidad_sap: cfg.sapEntity, mensaje: "Vista previa. Muestra al usuario y pide confirmación." }
              writer.write({ type: "data-tool-status", data: { toolCallId, text: `Creando documento en ${cfg.sapEntity}…` } } as never)
              try {
                const result = await client.sapWrite("POST", `/${cfg.sapEntity}`, parsed)
                return { creado: result.result, mensaje: "Documento creado exitosamente en SAP." }
              } catch (err) { return classifySapError(err) }
            },
          }),

          actualizar_documento: tool({
            description: "Modifica campos de un documento existente. REGLA: confirmar=false primero.",
            inputSchema: z.object({
              endpoint: z.string(),
              id: z.string(),
              cambios: z.string().describe("JSON con solo los campos a modificar"),
              confirmar: z.boolean(),
            }),
            execute: async ({ endpoint, id, cambios, confirmar }: { endpoint: string; id: string; cambios: string; confirmar: boolean }, { toolCallId }) => {
              const entityKey = endpoint.replace(/^\//, "")
              const cfg = ENTITY_MAP[entityKey]
              if (!cfg) return { error: { code: "INVALID_ENDPOINT", message: `Endpoint '${endpoint}' no reconocido.`, retryable: false } }
              let parsed: unknown
              try { parsed = JSON.parse(cambios) } catch { return { error: { code: "INVALID_JSON", message: "Los cambios no son JSON válido.", retryable: false } } }
              const key = cfg.keyType === "string" ? `('${encodeURIComponent(id)}')` : `(${id})`
              if (!confirmar) return { documento: `${cfg.sapEntity}${key}`, cambios: parsed, mensaje: "Vista previa. Muestra los campos a modificar y pide confirmación." }
              writer.write({ type: "data-tool-status", data: { toolCallId, text: `Actualizando ${cfg.sapEntity}${key}…` } } as never)
              try {
                await client.sapWrite("PATCH", `/${cfg.sapEntity}${key}`, parsed)
                return { actualizado: true, documento: `${cfg.sapEntity}${key}`, mensaje: "Documento actualizado exitosamente." }
              } catch (err) { return classifySapError(err) }
            },
          }),

          ejecutar_accion: tool({
            description: "Ejecuta una acción en un documento: Cancel, Close, Reopen. REGLA: confirmar=false primero — puede ser irreversible.",
            inputSchema: z.object({
              endpoint: z.string(),
              docEntry: z.coerce.number().int().positive().describe("DocEntry numérico del documento"),
              accion: z.string().describe("Cancel, Close o Reopen"),
              confirmar: z.boolean(),
            }),
            execute: async ({ endpoint, docEntry, accion, confirmar }: { endpoint: string; docEntry: number; accion: string; confirmar: boolean }, { toolCallId }) => {
              const entityKey = endpoint.replace(/^\//, "")
              const cfg = ENTITY_MAP[entityKey]
              if (!cfg) return { error: { code: "INVALID_ENDPOINT", message: `Endpoint '${endpoint}' no reconocido.`, retryable: false } }
              if (!cfg.allowedActions?.includes(accion)) {
                return { error: { code: "INVALID_ACTION", message: `Acción '${accion}' no permitida en '${endpoint}'. Válidas: ${cfg.allowedActions?.join(", ") ?? "ninguna"}`, retryable: false } }
              }
              if (!confirmar) return { accion, documento: `${cfg.sapEntity}(${docEntry})`, advertencia: `Esta acción ejecutará '${accion}' en el documento ${docEntry}. Puede ser irreversible. ¿Confirmas?` }
              writer.write({ type: "data-tool-status", data: { toolCallId, text: `Ejecutando ${accion} en ${cfg.sapEntity}(${docEntry})…` } } as never)
              try {
                const result = await client.sapWrite("ACTION", `/${cfg.sapEntity}(${docEntry})/${accion}`)
                return { ejecutado: true, accion, docEntry, mensaje: `Acción '${accion}' ejecutada exitosamente.`, detalles: result.result }
              } catch (err) { return classifySapError(err) }
            },
          }),
        },
      })

      for await (const chunk of result.toUIMessageStream({ sendReasoning: true })) {
        writer.write(chunk)
      }
      
      try {
        const usage = await result.usage
        if (usage) {
          // AI SDK v6: usage.inputTokens es el TOTAL (incluye cacheados).
          // El desglose real está en inputTokenDetails.
          const details = usage.inputTokenDetails
          const totalInput = usage.inputTokens ?? 0
          const cacheReadTokens = details?.cacheReadTokens ?? 0
          const cacheWriteTokens = details?.cacheWriteTokens ?? 0
          // noCache = total − cacheReads − cacheWrites (fallback al total si no hay detalle)
          const noCacheTokens = details?.noCacheTokens ?? Math.max(0, totalInput - cacheReadTokens - cacheWriteTokens)
          const completionTokens = usage.outputTokens ?? 0

          // Costo real con tarifas de caching (write 1.25×, read 0.10×), pricing del registro
          const { costUsd, savingsUsd } = calculateCostWithCacheForModel(modelCap, {
            noCacheTokens,
            cacheReadTokens,
            cacheWriteTokens,
            outputTokens: completionTokens,
          })

          const modelName = modelCap.name

          writer.write({
            type: "data-usage",
            data: {
              inputTokens: totalInput,
              outputTokens: completionTokens,
              cacheReadTokens,
              cacheWriteTokens,
              modelId: selectedModel,
              modelName,
              costUsd: Math.max(0, costUsd),
              savingsUsd: Math.max(0, savingsUsd)
            }
          } as never)
        }
      } catch (err) {
        console.error("Error enviando usage:", err)
      }
    },
  })

  return createUIMessageStreamResponse({ stream })
}, { label: "POST chat" }) as (req: Request) => Promise<Response>
