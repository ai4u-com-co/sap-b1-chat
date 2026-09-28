import { createHash } from "node:crypto"
import {
  buildToolCallLogRow,
  logToolCallResult,
  truncateForStorage,
  type ToolCallLogClient,
} from "@/lib/chat/tool-call-log"

/**
 * Persistencia del chat en Supabase (chat_sessions / chat_messages / chat_tool_calls).
 *
 * Estuvo 100% muerta en producción sin dar ningún error: cinco bloqueos
 * independientes, todos silenciosos porque supabase-js devuelve `{ error }` en
 * vez de lanzar y el código anterior tenía `try/catch {}` vacíos:
 *   1. Sin variables de Supabase en Vercel → el cliente era `null`.
 *   2. RLS activo y sin políticas → la anon key no puede escribir (ahora: service role).
 *   3. Columnas que no existen: `chat_sessions.updated_at`, `chat_messages.tool_calls/tool_results`.
 *   4. Ids de hilo `t<base36>` (MC) contra columnas `uuid`.
 *   5. `tenant_id` con FK a `tenants(id)`: "flexo" en la base vs "flexoimpresos" en el chat.
 * Este módulo corrige los cinco y REPORTA cada error de la base en vez de tragarlo.
 */

type DbError = { code?: string; message?: string; details?: string } | null | undefined
type DbResult = { error?: DbError } | unknown

export interface PersistDb extends ToolCallLogClient {
  from(table: string): {
    insert(row: never): PromiseLike<DbResult>
    upsert(row: never, opts?: { onConflict?: string; ignoreDuplicates?: boolean }): PromiseLike<DbResult>
  }
}

export interface PersistLogger {
  info(data: object, msg: string): void
  warn(data: object, msg: string): void
}

// Namespace fijo para el UUID v5 de las sesiones (no es secreto, solo estabilidad).
const SESSION_NAMESPACE = "8f2f6a6e-5b1f-4c1b-9d2e-7a4c3b1e0a11"

// El chat usa el id de tenant de SAP; la tabla `tenants` usa el id de Mission
// Control (MC mapea flexo → flexoimpresos en lib/chat-session.ts). Solo Flexo difiere.
const CHAT_TO_DB_TENANT: Record<string, string> = { flexoimpresos: "flexo" }

export function toDbTenantId(chatTenantId: string): string {
  return CHAT_TO_DB_TENANT[chatTenantId] ?? chatTenantId
}

/**
 * UUID v5 determinístico a partir de (usuario, hilo). Los ids de hilo de
 * Mission Control (`t<base36>`, useThreads.ts) viven en localStorage y no son
 * UUID; derivarlo evita migrar el cliente, mantiene estable la sesión por
 * conversación y, al incluir el usuario, impide que alguien "adopte" la sesión
 * de otro reusando su id de hilo.
 */
export function deriveSessionUuid(userId: string, threadId: string): string {
  const hash = createHash("sha1")
    .update(Buffer.from(SESSION_NAMESPACE.replace(/-/g, ""), "hex"))
    .update(`${userId}:${threadId}`)
    .digest()
  hash[6] = (hash[6] & 0x0f) | 0x50 // versión 5
  hash[8] = (hash[8] & 0x3f) | 0x80 // variante RFC 4122
  const h = hash.subarray(0, 16).toString("hex")
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

const DB_TIMEOUT_MS = 4_000
const TITLE_MAX = 44

function withDbTimeout<T>(p: PromiseLike<T>): Promise<T | { error: { code: string; message: string } }> {
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([
    Promise.resolve(p),
    new Promise<{ error: { code: string; message: string } }>((resolve) => {
      timer = setTimeout(() => resolve({ error: { code: "TIMEOUT", message: `Supabase no respondió en ${DB_TIMEOUT_MS}ms` } }), DB_TIMEOUT_MS)
    }),
  ]).finally(() => clearTimeout(timer))
}

function errorOf(res: unknown): DbError {
  return (res as { error?: DbError } | null | undefined)?.error
}

let warnedDisabled = false

export interface ChatPersistence {
  /** Id (uuid) de la sesión en la base; `null` hasta que start() la persistió con éxito. */
  readonly sessionId: string | null
  start(input: { userText: string }): Promise<void>
  saveAssistant(input: {
    text: string | undefined
    toolCalls: unknown[] | undefined
    toolResults: unknown[] | undefined
    modelId: string
  }): Promise<void>
  saveToolCall(event: {
    toolName: string
    toolCallId: string
    stepNumber: number | undefined
    durationMs: number
    input: unknown
    success: boolean
    output?: unknown
    error?: unknown
  }): Promise<void>
}

export function createChatPersistence(deps: {
  db: PersistDb | null
  log: PersistLogger
  tenantId: string
  userId: string | undefined
  threadId: string | undefined
}): ChatPersistence {
  const { db, log, tenantId, userId, threadId } = deps
  const dbTenant = toDbTenantId(tenantId)
  let sessionId: string | null = null

  const report = (table: string, error: unknown, extra: Record<string, unknown> = {}) => {
    const e = (error ?? {}) as { code?: string; message?: string; details?: string }
    log.warn(
      { table, dbCode: e.code, dbMessage: e.message ?? String(error), dbDetails: e.details, tenantId, dbTenant, ...extra },
      `chat: persistencia falló en ${table}${e.code === "23503" ? " (FK: ¿usuario sin fila en public.users, p. ej. master, o tenant inexistente?)" : ""}`,
    )
  }

  // Solo persiste con usuario identificado (x-user-id) y un id de hilo.
  const applicable = !!userId && !!threadId
  if (applicable && !db && !warnedDisabled) {
    warnedDisabled = true
    log.info({}, "chat: persistencia deshabilitada — falta SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY en este proyecto")
  }

  return {
    get sessionId() {
      return sessionId
    },

    async start({ userText }) {
      if (!applicable || !db) return
      const id = deriveSessionUuid(userId!, threadId!)
      const title = userText.length > TITLE_MAX ? userText.slice(0, TITLE_MAX - 1) + "…" : userText || "Nueva conversación"

      // ignoreDuplicates: el título queda con la PRIMERA pregunta, no se pisa en cada turno.
      const sessionRes = await withDbTimeout(
        db.from("chat_sessions").upsert(
          { id, tenant_id: dbTenant, user_id: userId, title, metadata: { threadId, chatTenantId: tenantId } } as never,
          { onConflict: "id", ignoreDuplicates: true },
        ),
      )
      const sessionErr = errorOf(sessionRes)
      if (sessionErr) return report("chat_sessions", sessionErr, { userId })
      sessionId = id

      const msgRes = await withDbTimeout(
        db.from("chat_messages").insert({ session_id: id, role: "user", content: userText, metadata: {} } as never),
      )
      const msgErr = errorOf(msgRes)
      if (msgErr) report("chat_messages", msgErr, { role: "user" })
    },

    async saveAssistant({ text, toolCalls, toolResults, modelId }) {
      if (!db || !sessionId) return
      if (!text && !(toolCalls && toolCalls.length > 0)) return
      const res = await withDbTimeout(
        db.from("chat_messages").insert({
          session_id: sessionId,
          role: "assistant",
          content: text ?? "",
          metadata: {
            modelId,
            toolCalls: truncateForStorage(toolCalls ?? []),
            toolResults: truncateForStorage(toolResults ?? []),
          },
        } as never),
      )
      const err = errorOf(res)
      if (err) report("chat_messages", err, { role: "assistant" })
    },

    async saveToolCall(event) {
      if (!db || !sessionId) return
      const row = buildToolCallLogRow({
        sessionId,
        tenantId: dbTenant,
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        stepNumber: event.stepNumber,
        durationMs: event.durationMs,
        input: event.input,
        sdkSuccess: event.success,
        output: event.success ? event.output : undefined,
        error: event.success ? undefined : event.error,
      })
      await logToolCallResult(db as unknown as ToolCallLogClient, row, (e) =>
        report("chat_tool_calls", e, { toolName: event.toolName }),
      )
    },
  }
}
