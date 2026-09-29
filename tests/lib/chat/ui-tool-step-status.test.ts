import { describe, it, expect } from "vitest"
import {
  classifyToolSteps,
  humanToolError,
  areRelatedTools,
  getToolStepError,
  type ToolStepInput,
} from "@/lib/chat/ui/tool-step-status"

const ok = (toolName: string, output: unknown = { rows: [], count: 0 }): ToolStepInput => ({ toolName, state: "output-available", output })
const fail = (toolName: string, code: string, retryable: boolean, requestId?: string): ToolStepInput => ({
  toolName,
  state: "output-available",
  output: { error: { code, message: `detalle ${code}`, retryable, ...(requestId ? { requestId } : {}) } },
})
const statuses = (steps: ToolStepInput[], streaming: boolean) => classifyToolSteps(steps, streaming).map((s) => s.status)

describe("classifyToolSteps", () => {
  it("éxito sin errores → ok", () => {
    expect(statuses([ok("consultar_sql")], false)).toEqual(["ok"])
  })

  it("703 (SAP_COLUMN_NOT_FOUND) seguido de consulta exitosa → corregido", () => {
    expect(statuses([fail("consultar_sql", "SAP_COLUMN_NOT_FOUND", true), ok("consultar_sql")], false)).toEqual(["corregido", "ok"])
  })

  it("SAP_TIMEOUT retryable + reintento exitoso → corregido", () => {
    expect(statuses([fail("kpi_negocio", "SAP_TIMEOUT", true), ok("kpi_negocio")], false)).toEqual(["corregido", "ok"])
  })

  it("error retryable seguido de éxito de otra tool no relacionada → corregido", () => {
    expect(statuses([fail("consultar_sql", "SAP_TIMEOUT", true), ok("kpi_negocio")], false)).toEqual(["corregido", "ok"])
  })

  it("SCHEMA_NOT_DISCOVERED → descubrir_esquema → consultar_sql ok: todo el grupo SQL cuenta como relacionado", () => {
    expect(
      statuses([fail("consultar_sql", "SCHEMA_NOT_DISCOVERED", true), ok("descubrir_esquema"), ok("consultar_sql")], false),
    ).toEqual(["corregido", "ok", "ok"])
  })

  it("error NO retryable nunca es corregido, aunque después funcione la misma tool", () => {
    expect(statuses([fail("consultar_sql", "SAP_ERROR", false), ok("consultar_sql")], false)).toEqual(["fallido", "ok"])
  })

  it("CHAT_TIMEOUT / TURN_BUDGET_EXHAUSTED (retryable:false) → fallido aunque haya éxitos posteriores", () => {
    expect(statuses([fail("consultar_sql", "CHAT_TIMEOUT", false), ok("consultar_sql")], false)).toEqual(["fallido", "ok"])
    expect(statuses([fail("kpi_negocio", "TURN_BUDGET_EXHAUSTED", false)], true)).toEqual(["fallido"])
  })

  it("código desconocido: se clasifica igual que cualquier error (por retryable)", () => {
    expect(statuses([fail("consultar_sql", "CODIGO_NUEVO_X", true), ok("consultar_sql")], false)).toEqual(["corregido", "ok"])
    expect(statuses([fail("consultar_sql", "CODIGO_NUEVO_X", true)], false)).toEqual(["fallido"])
  })

  it("output-error sin dato de retryable seguido de éxito de tool NO relacionada → fallido", () => {
    const step: ToolStepInput = { toolName: "consultar_sql", state: "output-error", errorText: "Invalid input" }
    expect(statuses([step, ok("kpi_negocio")], false)).toEqual(["fallido", "ok"])
  })

  it("error NO retryable seguido de éxito de tool no relacionada → fallido", () => {
    expect(statuses([fail("consultar_sql", "SAP_UNAVAILABLE", false), ok("kpi_negocio")], false)).toEqual(["fallido", "ok"])
  })

  it("error sin éxito posterior en un mensaje terminado → fallido", () => {
    expect(statuses([fail("consultar_sql", "SAP_TIMEOUT", true), fail("consultar_sql", "SAP_TIMEOUT", true)], false)).toEqual(["fallido", "fallido"])
  })

  it("un éxito ANTERIOR no corrige un error posterior", () => {
    expect(statuses([ok("consultar_sql"), fail("consultar_sql", "SAP_COLUMN_NOT_FOUND", true)], false)).toEqual(["ok", "fallido"])
  })

  it("en streaming, error recuperable sin éxito posterior → pendiente con retrying", () => {
    const [s] = classifyToolSteps([fail("consultar_sql", "SAP_COLUMN_NOT_FOUND", true)], true)
    expect(s.status).toBe("pendiente")
    expect(s.retrying).toBe(true)
    expect(s.error?.code).toBe("SAP_COLUMN_NOT_FOUND")
  })

  it("en streaming, error explícitamente NO retryable → fallido (no hay nada que esperar)", () => {
    expect(statuses([fail("consultar_sql", "SAP_UNAVAILABLE", false)], true)).toEqual(["fallido"])
  })

  it("en streaming, tool corriendo → pendiente sin retrying", () => {
    const [s] = classifyToolSteps([{ toolName: "consultar_sql", state: "input-available" }], true)
    expect(s).toEqual({ status: "pendiente", retrying: false })
  })

  it("output-error (excepción/input inválido) sin dato de retryable: pendiente en streaming, fallido al terminar", () => {
    const step: ToolStepInput = { toolName: "consultar_sql", state: "output-error", errorText: "Invalid input" }
    expect(statuses([step], true)).toEqual(["pendiente"])
    expect(statuses([step], false)).toEqual(["fallido"])
    expect(statuses([step, ok("consultar_sql")], false)).toEqual(["corregido", "ok"])
  })
})

describe("helpers", () => {
  it("areRelatedTools", () => {
    expect(areRelatedTools("consultar_sql", "descubrir_esquema")).toBe(true)
    expect(areRelatedTools("kpi_negocio", "kpi_negocio")).toBe(true)
    expect(areRelatedTools("consultar_sql", "kpi_negocio")).toBe(false)
  })

  it("getToolStepError lee output.error y errorText", () => {
    expect(getToolStepError(fail("x", "BAD_REQUEST", true))?.code).toBe("BAD_REQUEST")
    expect(getToolStepError({ toolName: "x", state: "output-error", errorText: "boom" })).toEqual({ message: "boom" })
    expect(getToolStepError(ok("x"))).toBeUndefined()
  })

  it("humanToolError nunca devuelve el código crudo", () => {
    for (const code of ["SAP_TIMEOUT", "SAP_COLUMN_NOT_FOUND", "SQL_RULE_CTE", "SAP_WRITE_UNCERTAIN", "CHAT_TIMEOUT", "TURN_BUDGET_EXHAUSTED", "CUALQUIER_OTRO"]) {
      const t = humanToolError({ code, message: "m" })
      expect(t).not.toContain(code)
      expect(t.length).toBeGreaterThan(10)
    }
    expect(humanToolError(undefined)).toBe("Este paso no se pudo completar.")
    expect(humanToolError({ code: "CHAT_TIMEOUT" })).toBe("El sistema tardó demasiado; la respuesta usa lo que alcanzó a consultar.")
    expect(humanToolError({ code: "TURN_BUDGET_EXHAUSTED" })).toBe("Se agotó el tiempo de esta respuesta.")
  })
})
