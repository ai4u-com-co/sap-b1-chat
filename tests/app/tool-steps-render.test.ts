import { describe, it, expect } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { ToolSteps, type AnyToolPart } from "@/app/components/ToolSteps"

// Parts con la forma real del AI SDK v6 (type `tool-<nombre>`, toolCallId, state, input, output).
const part = (name: string, id: string, output: unknown, state = "output-available") =>
  ({ type: `tool-${name}`, toolCallId: id, state, input: {}, output }) as unknown as AnyToolPart

const render = (parts: AnyToolPart[], streaming: boolean) =>
  renderToStaticMarkup(createElement(ToolSteps, { parts, toolStatusByCallId: new Map(), streaming, onRetry: () => {} }))

describe("ToolSteps (render)", () => {
  it("agrupa los pasos corregidos en un bloque plegado neutro, sin estilo de error", () => {
    const html = render(
      [
        part("consultar_sql", "a", { error: { code: "SAP_COLUMN_NOT_FOUND", message: "col", retryable: true, requestId: "req-1" } }),
        part("consultar_sql", "b", { error: { code: "SAP_TIMEOUT", message: "lento", retryable: true } }),
        part("consultar_sql", "c", { rows: [], count: 0 }),
      ],
      false,
    )
    expect(html).toContain("Ajustó la consulta 2 veces")
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('data-step-status="fallido"')
    expect(html).not.toContain("var(--ai4u-error)")
    // plegado: el detalle técnico no está en el DOM hasta abrir
    expect(html).not.toContain("SAP_COLUMN_NOT_FOUND")
    expect(html).toContain('data-step-status="ok"')
  })

  it("un paso fallido muestra texto humano + requestId, no el código crudo", () => {
    const html = render(
      [part("consultar_sql", "a", { error: { code: "SAP_TIMEOUT", message: "SAP B1 está lento…", retryable: true, requestId: "req-42" } })],
      false,
    )
    expect(html).toContain('data-step-status="fallido"')
    expect(html).toContain("SAP tardó demasiado en responder")
    expect(html).toContain("Ref: req-42")
    expect(html).toContain("Reintentar")
    expect(html).not.toContain("SAP_TIMEOUT")
  })

  it("en streaming, un error recuperable se ve como 'reintentando…' neutro", () => {
    const html = render([part("consultar_sql", "a", { error: { code: "SAP_TIMEOUT", message: "x", retryable: true } })], true)
    expect(html).toContain("reintentando…")
    expect(html).not.toContain('data-step-status="fallido"')
    expect(html).not.toContain("var(--ai4u-error)")
  })

  it("con varios pasos fallidos, un solo botón Reintentar (en el último)", () => {
    const err = { error: { code: "SAP_TIMEOUT", message: "x", retryable: true } }
    const html = render([part("consultar_sql", "a", err), part("consultar_sql", "b", err)], false)
    expect(html.match(/data-step-status="fallido"/g)).toHaveLength(2)
    expect(html.match(/Reintentar/g)).toHaveLength(1)
  })
})
