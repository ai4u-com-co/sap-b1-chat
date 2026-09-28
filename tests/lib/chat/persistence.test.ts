import { describe, it, expect, vi, afterEach } from "vitest"
import { createChatPersistence, deriveSessionUuid, toDbTenantId, type PersistDb } from "@/lib/chat/persistence"

type Call = { table: string; op: "insert" | "upsert"; row: Record<string, unknown>; opts?: Record<string, unknown> }

// Base simulada: devuelve `{ error }` como supabase-js (nunca lanza).
function makeDb(results: Record<string, unknown> = {}) {
  const calls: Call[] = []
  const db = {
    from: (table: string) => ({
      insert: (row: Record<string, unknown>) => {
        calls.push({ table, op: "insert", row })
        return Promise.resolve(results[`${table}.insert`] ?? { error: null })
      },
      upsert: (row: Record<string, unknown>, opts?: Record<string, unknown>) => {
        calls.push({ table, op: "upsert", row, opts })
        return Promise.resolve(results[`${table}.upsert`] ?? { error: null })
      },
    }),
  } as unknown as PersistDb
  return { db, calls }
}

const makeLog = () => ({ info: vi.fn(), warn: vi.fn() })
const UUID_V5 = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

afterEach(() => {
  vi.useRealTimers()
})

describe("deriveSessionUuid", () => {
  it("genera un UUID v5 válido a partir de un id de hilo t<base36> (que NO es uuid)", () => {
    expect(deriveSessionUuid("c588820f-2d0c-4284-9a42-f7ddd556c349", "tmg1a2b3xyz")).toMatch(UUID_V5)
  })

  it("es determinístico: mismo usuario + mismo hilo = misma sesión", () => {
    expect(deriveSessionUuid("u1", "t1")).toBe(deriveSessionUuid("u1", "t1"))
  })

  it("cambia con el hilo y con el usuario (nadie adopta la sesión de otro reusando su id de hilo)", () => {
    const base = deriveSessionUuid("u1", "t1")
    expect(deriveSessionUuid("u1", "t2")).not.toBe(base)
    expect(deriveSessionUuid("u2", "t1")).not.toBe(base)
  })
})

describe("toDbTenantId", () => {
  it("mapea flexoimpresos (id de SAP/chat) a flexo (id de la tabla tenants)", () => {
    expect(toDbTenantId("flexoimpresos")).toBe("flexo")
  })
  it("deja igual los demás", () => {
    expect(toDbTenantId("tamaprint")).toBe("tamaprint")
  })
})

describe("start()", () => {
  const base = { userId: "u-1", threadId: "tabc123" }

  it("crea la sesión con columnas REALES (sin updated_at), uuid derivado, tenant de la tabla y sin pisar el título", async () => {
    const { db, calls } = makeDb()
    const p = createChatPersistence({ db, log: makeLog(), tenantId: "flexoimpresos", ...base })
    await p.start({ userText: "¿Cuánto facturamos hoy?" })

    const session = calls.find((c) => c.table === "chat_sessions")!
    expect(session.op).toBe("upsert")
    expect(session.row.id).toBe(deriveSessionUuid("u-1", "tabc123"))
    expect(session.row.tenant_id).toBe("flexo")
    expect(session.row.user_id).toBe("u-1")
    expect(session.row.title).toBe("¿Cuánto facturamos hoy?")
    expect(session.row).not.toHaveProperty("updated_at") // la columna no existe en la tabla
    expect(session.opts).toEqual({ onConflict: "id", ignoreDuplicates: true })
    expect(p.sessionId).toBe(session.row.id)
  })

  it("inserta el mensaje del usuario como TEXTO (content es text, no un arreglo de partes)", async () => {
    const { db, calls } = makeDb()
    const p = createChatPersistence({ db, log: makeLog(), tenantId: "tamaprint", ...base })
    await p.start({ userText: "hola" })
    const msg = calls.find((c) => c.table === "chat_messages")!
    expect(msg.row).toMatchObject({ session_id: p.sessionId, role: "user", content: "hola", metadata: {} })
  })

  it("trunca el título a 44 caracteres con elipsis y usa un título por defecto si no hay texto", async () => {
    const a = makeDb()
    await createChatPersistence({ db: a.db, log: makeLog(), tenantId: "tamaprint", ...base }).start({ userText: "x".repeat(80) })
    const title = a.calls.find((c) => c.table === "chat_sessions")!.row.title as string
    expect(title).toHaveLength(44)
    expect(title.endsWith("…")).toBe(true)

    const b = makeDb()
    await createChatPersistence({ db: b.db, log: makeLog(), tenantId: "tamaprint", ...base }).start({ userText: "" })
    expect(b.calls.find((c) => c.table === "chat_sessions")!.row.title).toBe("Nueva conversación")
  })

  it("si la sesión falla (FK de usuario), lo REPORTA con la pista y no escribe nada más", async () => {
    const { db, calls } = makeDb({ "chat_sessions.upsert": { error: { code: "23503", message: "violates foreign key constraint" } } })
    const log = makeLog()
    const p = createChatPersistence({ db, log, tenantId: "tamaprint", ...base })
    await p.start({ userText: "hola" })

    expect(p.sessionId).toBeNull()
    expect(log.warn).toHaveBeenCalledTimes(1)
    const [data, msg] = log.warn.mock.calls[0]
    expect(data).toMatchObject({ table: "chat_sessions", dbCode: "23503" })
    expect(msg).toMatch(/FK: ¿usuario sin fila en public\.users/)
    expect(calls.filter((c) => c.table === "chat_messages")).toHaveLength(0)

    // y el resto del turno queda inerte, sin más llamadas a la base
    await p.saveAssistant({ text: "respuesta", toolCalls: [], toolResults: [], modelId: "m" })
    await p.saveToolCall({ toolName: "t", toolCallId: "c", stepNumber: 0, durationMs: 1, input: {}, success: true, output: {} })
    expect(calls).toHaveLength(1)
  })

  it("si Supabase no responde en 4 s, no cuelga el chat: reporta TIMEOUT y sigue", async () => {
    vi.useFakeTimers()
    const db = { from: () => ({ upsert: () => new Promise(() => {}), insert: () => new Promise(() => {}) }) } as unknown as PersistDb
    const log = makeLog()
    const p = createChatPersistence({ db, log, tenantId: "tamaprint", ...base })
    const started = p.start({ userText: "hola" })
    await vi.advanceTimersByTimeAsync(4_100)
    await started
    expect(p.sessionId).toBeNull()
    expect(log.warn.mock.calls[0][0]).toMatchObject({ table: "chat_sessions", dbCode: "TIMEOUT" })
  })

  it("no hace nada sin usuario o sin id de hilo (acceso directo / sin sesión de MC)", async () => {
    for (const extra of [{ userId: undefined, threadId: "t1" }, { userId: "u-1", threadId: undefined }]) {
      const { db, calls } = makeDb()
      const p = createChatPersistence({ db, log: makeLog(), tenantId: "tamaprint", ...extra })
      await p.start({ userText: "hola" })
      expect(calls).toHaveLength(0)
      expect(p.sessionId).toBeNull()
    }
  })

  it("sin cliente de Supabase: no lanza y avisa UNA sola vez que la persistencia está deshabilitada", async () => {
    vi.resetModules()
    const mod = await import("@/lib/chat/persistence")
    const log = makeLog()
    for (let i = 0; i < 3; i++) {
      const p = mod.createChatPersistence({ db: null, log, tenantId: "tamaprint", ...base })
      await expect(p.start({ userText: "hola" })).resolves.toBeUndefined()
    }
    expect(log.info).toHaveBeenCalledTimes(1)
    expect(log.info.mock.calls[0][1]).toMatch(/deshabilitada.*SUPABASE_SERVICE_ROLE_KEY/)
  })
})

describe("saveAssistant()", () => {
  const ready = async (results: Record<string, unknown> = {}) => {
    const { db, calls } = makeDb(results)
    const log = makeLog()
    const p = createChatPersistence({ db, log, tenantId: "flexoimpresos", userId: "u-1", threadId: "t1" })
    await p.start({ userText: "hola" })
    calls.length = 0
    return { p, calls, log }
  }

  it("guarda tool_calls/tool_results dentro de metadata (las columnas top-level no existen)", async () => {
    const { p, calls } = await ready()
    await p.saveAssistant({ text: "Facturamos $10", toolCalls: [{ toolName: "x" }], toolResults: [{ ok: 1 }], modelId: "claude-haiku-4.5" })
    const row = calls[0].row
    expect(row).toMatchObject({ role: "assistant", content: "Facturamos $10" })
    expect(row).not.toHaveProperty("tool_calls")
    expect(row).not.toHaveProperty("tool_results")
    expect(row.metadata).toEqual({ modelId: "claude-haiku-4.5", toolCalls: [{ toolName: "x" }], toolResults: [{ ok: 1 }] })
  })

  it("solo tool calls, sin texto: content vacío pero se guarda", async () => {
    const { p, calls } = await ready()
    await p.saveAssistant({ text: "", toolCalls: [{ toolName: "x" }], toolResults: [], modelId: "m" })
    expect(calls[0].row.content).toBe("")
  })

  it("sin texto ni tool calls: no inserta nada", async () => {
    const { p, calls } = await ready()
    await p.saveAssistant({ text: "", toolCalls: [], toolResults: [], modelId: "m" })
    expect(calls).toHaveLength(0)
  })

  it("reporta el error de la base en vez de tragarlo", async () => {
    const { p, log } = await ready({ "chat_messages.insert": { error: { code: "42703", message: "column does not exist" } } })
    await p.saveAssistant({ text: "hola", toolCalls: [], toolResults: [], modelId: "m" })
    expect(log.warn.mock.calls.at(-1)![0]).toMatchObject({ table: "chat_messages", dbCode: "42703", role: "assistant" })
  })
})

describe("saveToolCall()", () => {
  it("inserta en chat_tool_calls con la sesión uuid y el tenant de la tabla", async () => {
    const { db, calls } = makeDb()
    const p = createChatPersistence({ db, log: makeLog(), tenantId: "flexoimpresos", userId: "u-1", threadId: "t1" })
    await p.start({ userText: "hola" })
    calls.length = 0

    await p.saveToolCall({ toolName: "consultar_sql", toolCallId: "call_1", stepNumber: 2, durationMs: 120, input: { sql: "SELECT 1" }, success: true, output: { error: { code: "SAP_ERROR" } } })
    expect(calls[0].table).toBe("chat_tool_calls")
    expect(calls[0].row).toMatchObject({
      session_id: p.sessionId,
      tenant_id: "flexo",
      tool_name: "consultar_sql",
      tool_call_id: "call_1",
      step_number: 2,
      duration_ms: 120,
      success: false, // la tool devolvió { error } como retorno normal
    })
  })

  it("reporta si la inserción en chat_tool_calls falla", async () => {
    const { db } = makeDb({ "chat_tool_calls.insert": { error: { code: "23503", message: "fk" } } })
    const log = makeLog()
    const p = createChatPersistence({ db, log, tenantId: "tamaprint", userId: "u-1", threadId: "t1" })
    await p.start({ userText: "hola" })
    await p.saveToolCall({ toolName: "x", toolCallId: "c", stepNumber: 0, durationMs: 1, input: {}, success: true, output: {} })
    expect(log.warn.mock.calls.at(-1)![0]).toMatchObject({ table: "chat_tool_calls", toolName: "x" })
  })
})
