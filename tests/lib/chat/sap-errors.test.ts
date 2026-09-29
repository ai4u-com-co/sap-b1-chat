import { describe, it, expect } from "vitest"
import { BackendError } from "@ai4u/contracts"
import { classifySapError } from "@/lib/chat/sap-errors"
import { ChatStoppedWaitingError } from "@/lib/chat/with-timeout"

const be = (status: number, body: object | string, requestId?: string, method = "POST", path = "/query") =>
  new BackendError(method, path, status, typeof body === "string" ? body : JSON.stringify(body), requestId)

describe("classifySapError con BackendError (contracts >= 0.5.0)", () => {
  it("SAP_TIMEOUT del backend (el caso de la captura del 29-sep) → retryable y le dice al LLM que NO reescriba el SQL", () => {
    const { error } = classifySapError(
      be(504, { error: "SAP B1 no respondió a tiempo. Reintenta en unos segundos.", code: "SAP_TIMEOUT", uncertain: false }, "rid-1"),
    )
    expect(error.code).toBe("SAP_TIMEOUT")
    expect(error.retryable).toBe(true)
    expect(error.message).toMatch(/NO de tu consulta/)
    expect(error.message).toMatch(/no reescribas el SQL/)
    expect(error.requestId).toBe("rid-1")
  })

  it("nunca pasa el cuerpo JSON crudo al LLM", () => {
    const { error } = classifySapError(be(504, { error: "x", code: "SAP_TIMEOUT" }))
    expect(error.message).not.toContain("{")
    expect(error.message).not.toContain("Backend POST")
  })

  it("703 estructurado (table/column) → sugerencias de columnas, con requestId", () => {
    const { error } = classifySapError(
      be(502, { error: "SAP rechazó la consulta.", code: "SAP_QUERY_ERROR", sapCode: "703", sapMessage: "Column 'FederalTaxID' from table 'OCRD' not exist.", table: "OCRD", column: "FederalTaxID" }, "rid-2"),
    )
    expect(error.code).toBe("SAP_COLUMN_NOT_FOUND")
    expect(error.message).toContain('el nombre correcto es "LicTradNum"')
    expect(error.requestId).toBe("rid-2")
  })

  it("703 solo con sapMessage (sin table/column) también se reconoce", () => {
    const { error } = classifySapError(
      be(502, { error: "x", code: "SAP_QUERY_ERROR", sapCode: "703", sapMessage: `Column '\\"Remarks\\"' from table 'OWOR' not exist.` }),
    )
    expect(error.code).toBe("SAP_COLUMN_NOT_FOUND")
    expect(error.message).toContain('"Remarks" NO existe en la tabla OWOR')
  })

  it("702 → tabla no accesible vía SQL, sugiere OData", () => {
    const { error } = classifySapError(be(502, { error: "x", code: "SAP_QUERY_ERROR", sapCode: "702", sapMessage: "Table not accessible" }))
    expect(error.code).toBe("SAP_TABLE_NOT_ACCESSIBLE")
    expect(error.message).toMatch(/OData/)
  })

  it("SAP_QUERY_ERROR con detalle de SAP lo incluye (saneado por el backend) y es reintentable", () => {
    const { error } = classifySapError(
      be(502, { error: "SAP rechazó la consulta.", code: "SAP_QUERY_ERROR", sapCode: "-1000", sapMessage: "Syntax error near 'FROM'" }),
    )
    expect(error.code).toBe("SAP_QUERY_ERROR")
    expect(error.message).toContain("Detalle de SAP (-1000): Syntax error near 'FROM'")
    expect(error.retryable).toBe(true)
  })

  it("SAP_QUERY_ERROR sin detalle (backend viejo) → manda a descubrir_esquema, sin cuerpo crudo", () => {
    const { error } = classifySapError(be(502, { error: "SAP rechazó la consulta.", code: "SAP_QUERY_ERROR" }))
    expect(error.message).toMatch(/descubrir_esquema/)
    expect(error.message).not.toContain("{")
  })

  it.each([
    ["SAP_UNREACHABLE", "SAP_UNAVAILABLE", false],
    ["SAP_AUTH_UNAVAILABLE", "SAP_UNAVAILABLE", false],
    ["SAP_UNAUTHORIZED", "SAP_AUTH", false],
    ["NOT_FOUND", "SAP_NOT_FOUND", false],
    ["SAP_WRITE_UNCERTAIN", "SAP_WRITE_UNCERTAIN", false],
  ])("code %s → %s (retryable=%s)", (code, expected, retryable) => {
    const { error } = classifySapError(be(502, { error: "msg seguro", code }))
    expect(error.code).toBe(expected)
    expect(error.retryable).toBe(retryable)
  })

  it("504 de la plataforma con HTML (sin code) → SAP_TIMEOUT", () => {
    const { error } = classifySapError(be(504, "<html>Gateway Timeout</html>"))
    expect(error.code).toBe("SAP_TIMEOUT")
  })

  it("401 del backend (el chat se autenticó mal) → BACKEND_AUTH no reintentable", () => {
    const { error } = classifySapError(be(401, { error: "No autorizado" }))
    expect(error).toMatchObject({ code: "BACKEND_AUTH", retryable: false })
  })

  it("sin requestId no agrega la propiedad", () => {
    const { error } = classifySapError(be(504, { code: "SAP_TIMEOUT" }))
    expect(error).not.toHaveProperty("requestId")
  })
})

describe("classifySapError con errores locales (no BackendError)", () => {
  it("el corte propio del chat (ChatStoppedWaitingError) → CHAT_TIMEOUT no reintentable (el backend puede seguir trabajando)", () => {
    expect(classifySapError(new ChatStoppedWaitingError(65_000)).error).toMatchObject({ code: "CHAT_TIMEOUT", retryable: false })
  })

  it("'Timeout'/'aborted' local en cualquier caso → CHAT_TIMEOUT, no SAP_ERROR ni SAP_TIMEOUT reintentable", () => {
    expect(classifySapError(new Error("Request TIMEOUT")).error).toMatchObject({ code: "CHAT_TIMEOUT", retryable: false })
    expect(classifySapError(new Error("This operation was aborted")).error).toMatchObject({ code: "CHAT_TIMEOUT", retryable: false })
  })

  it("fetch failed → SAP_UNAVAILABLE", () => {
    expect(classifySapError(new TypeError("fetch failed")).error.code).toBe("SAP_UNAVAILABLE")
  })

  it("texto con el 703 de SAP (formato viejo) sigue funcionando", () => {
    const msg = `Backend POST /query (500): {"error":{"message":"Column '\\"Remarks\\"' from table 'OWOR' not exist."}}`
    expect(classifySapError(new Error(msg)).error.code).toBe("SAP_COLUMN_NOT_FOUND")
  })

  it("error desconocido → mensaje genérico, nunca el texto crudo", () => {
    const { error } = classifySapError(new Error('Backend GET /x (500): {"secret":"no-mostrar"}'))
    expect(error.code).toBe("SAP_ERROR")
    expect(error.message).not.toContain("no-mostrar")
  })
})
