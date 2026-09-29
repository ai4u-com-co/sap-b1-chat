import { describe, it, expect } from "vitest"
import { detectIntent, normalize } from "@/lib/chat/intent"

describe("detectIntent", () => {
  it.each([
    "¿cuánto facturamos este mes?",           // la captura del 29-sep: antes NO escalaba
    "¿Cuánto vendimos la semana pasada?",
    "eso incluye IVA o qué?",
    "¿Cuál es la cartera vencida de Flexo?",
    "top 10 clientes por venta",
    "margen bruto por línea",
    "¿qué clientes nos deben más?",
    "¿cómo va el flujo de caja?",
  ])("cifras de negocio → precisión: %s", (q) => {
    const i = detectIntent([q])
    expect(i.needsPrecision).toBe(true)
    expect(i.kinds).toContain("cifras")
  })

  it.each([
    "compara septiembre vs agosto",
    "evolución de ventas del trimestre",
    "hazme un informe mensual",
  ])("análisis → precisión: %s", (q) => {
    expect(detectIntent([q]).kinds).toContain("analisis")
  })

  it.each([
    "crea un pedido para el cliente C001",
    "cancela la orden de compra 341",
    "actualiza la fecha de entrega",
  ])("escritura en SAP → precisión: %s", (q) => {
    expect(detectIntent([q]).kinds).toContain("escritura")
  })

  it.each(["hola", "gracias!", "¿qué puedes hacer?", "¿quién eres?", "explícame qué es un OWOR"])(
    "conversación sin cifras → no escala: %s",
    (q) => {
      expect(detectIntent([q]).needsPrecision).toBe(false)
    },
  )

  it("no hay falsos positivos por subcadena (antes 'top' matcheaba 'laptop' y 'hacer' todo)", () => {
    expect(detectIntent(["tengo una laptop nueva"]).needsPrecision).toBe(false)
    expect(detectIntent(["¿qué debo hacer para entrar?"]).kinds).not.toContain("escritura")
  })

  it("una repregunta corta hereda la intención del hilo reciente", () => {
    const hilo = ["¿cuánto facturamos en septiembre?", "¿y en agosto?"]
    expect(detectIntent(hilo).needsPrecision).toBe(true)
    // sin el hilo, "¿y en agosto?" sola no escala
    expect(detectIntent(["¿y en agosto?"]).needsPrecision).toBe(false)
  })

  it("solo mira los últimos N mensajes (lookback)", () => {
    const hilo = ["¿cuánto facturamos?", "hola", "gracias", "¿quién eres?"]
    expect(detectIntent(hilo, 3).needsPrecision).toBe(false)
    expect(detectIntent(hilo, 4).needsPrecision).toBe(true)
  })

  it("devuelve las palabras que dispararon, sin duplicados", () => {
    const i = detectIntent(["¿cuánto facturamos? ¿cuánto facturamos?"])
    expect(i.matches).toEqual(expect.arrayContaining(["cuant", "factur"]))
    expect(new Set(i.matches).size).toBe(i.matches.length)
  })

  it("normalize quita tildes y pasa a minúsculas", () => {
    expect(normalize("¿Cuánto FACTURAMOS?")).toBe("¿cuanto facturamos?")
  })
})
