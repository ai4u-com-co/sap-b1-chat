import { describe, it, expect } from "vitest"
import { APICallError } from "@ai-sdk/provider"
import {
  keyFingerprint,
  resolveAnthropicKey,
  classifyAnthropicError,
  anthropicErrorLogFields,
} from "@/lib/chat/anthropic-errors"

/**
 * Incidente 2026-08-23: el chat de tamaprint respondía el texto crudo de
 * Anthropic "Your credit balance is too low to access the Anthropic API" y
 * los logs solo decían "error durante streaming (Anthropic/tool loop)" — sin
 * tenant, sin status, sin tipo, sin forma de saber qué key (y por tanto qué
 * ORGANIZACIÓN de Anthropic, la cuenta tiene 5) estaba en uso.
 */

// Key sintética con la forma real (sk-ant-api03- + ~95 chars). No es una key.
const FAKE_KEY = "sk-ant-api03-aub" + "X".repeat(88) + "vAAA"

function anthropicApiError(status: number, type: string, message: string): APICallError {
  return new APICallError({
    message,
    url: "https://api.anthropic.com/v1/messages",
    requestBodyValues: {},
    statusCode: status,
    responseBody: JSON.stringify({ type: "error", error: { type, message } }),
    isRetryable: status === 429 || status === 529 || status >= 500,
  })
}

describe("keyFingerprint", () => {
  it("devuelve prefijo+sufijo con el mismo formato que el Console de Anthropic (sk-ant-api03-aub…vAAA)", () => {
    expect(keyFingerprint(FAKE_KEY)).toBe("sk-ant-api03-aub…vAAA")
  })
  it("nunca incluye la key completa", () => {
    const fp = keyFingerprint(FAKE_KEY)
    expect(fp.length).toBeLessThan(25)
    expect(FAKE_KEY.includes(fp)).toBe(false)
  })
  it("marca vacía / corta sin romper", () => {
    expect(keyFingerprint("")).toBe("(vacía)")
    expect(keyFingerprint(undefined)).toBe("(vacía)")
    expect(keyFingerprint("sk-ant-corta")).toMatch(/corta:12/)
  })
})

describe("resolveAnthropicKey", () => {
  it("prefiere {TENANT}_ANTHROPIC_API_KEY y reporta source=tenant", () => {
    const r = resolveAnthropicKey("tamaprint", { TAMAPRINT_ANTHROPIC_API_KEY: FAKE_KEY, ANTHROPIC_API_KEY: "sk-ant-api03-global" + "Y".repeat(90) })
    expect(r.source).toBe("tenant")
    expect(r.envName).toBe("TAMAPRINT_ANTHROPIC_API_KEY")
    expect(r.key).toBe(FAKE_KEY)
    expect(r.fingerprint).toBe("sk-ant-api03-aub…vAAA")
  })
  it("cae a ANTHROPIC_API_KEY con source=global", () => {
    const r = resolveAnthropicKey("flexoimpresos", { ANTHROPIC_API_KEY: FAKE_KEY })
    expect(r.source).toBe("global")
    expect(r.envName).toBe("ANTHROPIC_API_KEY")
  })
  it("source=none cuando no hay ninguna, indicando qué env var se esperaba", () => {
    const r = resolveAnthropicKey("lamagdalena", {})
    expect(r.source).toBe("none")
    expect(r.key).toBe("")
    expect(r.envName).toBe("LAMAGDALENA_ANTHROPIC_API_KEY")
    expect(r.fingerprint).toBe("(vacía)")
  })
})

describe("classifyAnthropicError", () => {
  const BILLING_MSG = "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."

  it("400 'credit balance is too low' → ANTHROPIC_BILLING con mensaje en español + tenant + crudo", () => {
    const c = classifyAnthropicError(anthropicApiError(400, "invalid_request_error", BILLING_MSG), { tenantId: "tamaprint" })
    expect(c.code).toBe("ANTHROPIC_BILLING")
    expect(c.statusCode).toBe(400)
    expect(c.anthropicType).toBe("invalid_request_error")
    expect(c.retryable).toBe(false)
    expect(c.userMessage).toContain("tamaprint")
    expect(c.userMessage).toContain("no tiene crédito")
    expect(c.userMessage).toContain(BILLING_MSG)
    expect(c.operatorHint).toContain("TAMAPRINT_ANTHROPIC_API_KEY")
    expect(c.operatorHint).toContain("ORGANIZACIÓN")
  })

  it("billing también se detecta cuando llega como Error genérico a mitad del stream (sin statusCode)", () => {
    const c = classifyAnthropicError(new Error(BILLING_MSG), { tenantId: "tamaprint" })
    expect(c.code).toBe("ANTHROPIC_BILLING")
    expect(c.statusCode).toBeUndefined()
  })

  it("401 authentication_error → ANTHROPIC_AUTH", () => {
    const c = classifyAnthropicError(anthropicApiError(401, "authentication_error", "invalid x-api-key"), { tenantId: "flexoimpresos" })
    expect(c.code).toBe("ANTHROPIC_AUTH")
    expect(c.userMessage).toContain("flexoimpresos")
    expect(c.operatorHint).toContain("FLEXOIMPRESOS_ANTHROPIC_API_KEY")
  })

  it("429 → ANTHROPIC_RATE_LIMIT retryable", () => {
    const c = classifyAnthropicError(anthropicApiError(429, "rate_limit_error", "Number of request tokens has exceeded your per-minute rate limit"))
    expect(c.code).toBe("ANTHROPIC_RATE_LIMIT")
    expect(c.retryable).toBe(true)
  })

  it("529 overloaded_error → ANTHROPIC_OVERLOADED retryable", () => {
    const c = classifyAnthropicError(anthropicApiError(529, "overloaded_error", "Overloaded"))
    expect(c.code).toBe("ANTHROPIC_OVERLOADED")
    expect(c.retryable).toBe(true)
  })

  it("404 not_found_error → ANTHROPIC_MODEL_NOT_FOUND", () => {
    const c = classifyAnthropicError(anthropicApiError(404, "not_found_error", "model: claude-x"))
    expect(c.code).toBe("ANTHROPIC_MODEL_NOT_FOUND")
  })

  it("400 que no es billing → ANTHROPIC_INVALID_REQUEST (no se confunde con saldo)", () => {
    const c = classifyAnthropicError(anthropicApiError(400, "invalid_request_error", "thinking.budget_tokens must be >= 1024"))
    expect(c.code).toBe("ANTHROPIC_INVALID_REQUEST")
    expect(c.operatorHint).toContain("NO es billing")
  })

  it("AI_NoOutputGeneratedError → NO_OUTPUT", () => {
    const e = new Error("No output generated. Check the stream for errors.")
    e.name = "AI_NoOutputGeneratedError"
    const c = classifyAnthropicError(e)
    expect(c.code).toBe("NO_OUTPUT")
  })

  it("UNKNOWN conserva el mensaje crudo tal cual como userMessage (comportamiento previo, FLX-082)", () => {
    const c = classifyAnthropicError(new Error("algo raro 12345"))
    expect(c.code).toBe("UNKNOWN")
    expect(c.userMessage).toBe("algo raro 12345")
  })

  it("no revienta con valores no-Error", () => {
    expect(classifyAnthropicError("string error").code).toBe("UNKNOWN")
    expect(classifyAnthropicError(undefined).rawMessage).toBe("undefined")
  })
})

describe("anthropicErrorLogFields", () => {
  it("expone código/status/tipo/hint + fuente y fingerprint de la key, nunca la key", () => {
    const key = resolveAnthropicKey("tamaprint", { TAMAPRINT_ANTHROPIC_API_KEY: FAKE_KEY })
    const c = classifyAnthropicError(anthropicApiError(400, "invalid_request_error", "Your credit balance is too low"), { tenantId: "tamaprint" })
    const fields = anthropicErrorLogFields(c, key)
    expect(fields).toMatchObject({
      anthropicCode: "ANTHROPIC_BILLING",
      anthropicStatus: 400,
      anthropicType: "invalid_request_error",
      keySource: "tenant",
      keyEnv: "TAMAPRINT_ANTHROPIC_API_KEY",
      keyFingerprint: "sk-ant-api03-aub…vAAA",
    })
    expect(JSON.stringify(fields)).not.toContain(FAKE_KEY)
  })
})
