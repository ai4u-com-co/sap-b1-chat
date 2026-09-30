/**
 * Contrato de env v1 (fase 1): resolución de URL/llave del gateway, secreto interno
 * y key de Anthropic por tenant. Valores de prueba armados en runtime (nunca
 * literales con forma de secreto: el repo puede pasar por gitleaks).
 */
import { describe, it, expect } from "vitest"
import {
  getBackendUrl,
  resolveGatewayApiKey,
  LOCAL_GATEWAY_URL,
  SapBackendUrlMissingError,
  sapBackendUnavailableResponse,
} from "@/lib/sap-gateway"
import { verifyInternalSecret, getOutgoingInternalSecret } from "@/lib/internal-auth"
import { resolveAnthropicKey } from "@/lib/chat/anthropic-errors"

const val = (...parts: string[]) => parts.join("-")

describe("gateway: URL", () => {
  it("canónico SAP_BACKEND_URL gana sobre los alias", () => {
    expect(getBackendUrl({ SAP_BACKEND_URL: "https://c.test", NEXT_PUBLIC_BACKEND_URL: "https://a.test" })).toBe("https://c.test")
  })
  it("BACKEND_URL antes que NEXT_PUBLIC_BACKEND_URL (mismo orden que antes)", () => {
    expect(getBackendUrl({ BACKEND_URL: "https://s.test", NEXT_PUBLIC_BACKEND_URL: "https://p.test" })).toBe("https://s.test")
  })
  it("solo NEXT_PUBLIC_BACKEND_URL (lo que hay en Vercel prod) resuelve por alias", () => {
    expect(getBackendUrl({ NEXT_PUBLIC_BACKEND_URL: "https://p.test" })).toBe("https://p.test")
  })
  it("development sin nada → localhost (conveniencia local)", () => {
    expect(getBackendUrl({})).toBe(LOCAL_GATEWAY_URL)
    expect(getBackendUrl({ VERCEL_ENV: "development" })).toBe(LOCAL_GATEWAY_URL)
  })
  it("preview sin nada → localhost (conveniencia local)", () => {
    expect(getBackendUrl({ VERCEL_ENV: "preview" })).toBe(LOCAL_GATEWAY_URL)
  })
  it("production sin nada → lanza SapBackendUrlMissingError (nunca localhost)", () => {
    expect(() => getBackendUrl({ VERCEL_ENV: "production" })).toThrow(SapBackendUrlMissingError)
    expect(() => getBackendUrl({ VERCEL_ENV: "production" })).toThrow("SAP_BACKEND_URL no configurada")
  })
  it("production con URL (canónico o alias) → la URL", () => {
    expect(getBackendUrl({ VERCEL_ENV: "production", SAP_BACKEND_URL: "https://c.test" })).toBe("https://c.test")
    expect(getBackendUrl({ VERCEL_ENV: "production", NEXT_PUBLIC_BACKEND_URL: "https://p.test" })).toBe("https://p.test")
  })
})

describe("gateway: sapBackendUnavailableResponse", () => {
  it("SapBackendUrlMissingError → 503 con mensaje genérico", async () => {
    const res = sapBackendUnavailableResponse(new SapBackendUrlMissingError())
    expect(res?.status).toBe(503)
    expect(await res!.json()).toEqual({ error: "Servicio SAP no disponible temporalmente" })
  })
  it("otro error → null (el handler conserva su respuesta)", () => {
    expect(sapBackendUnavailableResponse(new Error("otro"))).toBeNull()
    expect(sapBackendUnavailableResponse(undefined)).toBeNull()
  })
})

describe("gateway: llave por tenant", () => {
  it("{TENANT}_SAP_API_KEY del tenant", () => {
    const k1 = val("t", "k")
    const k2 = val("f", "k")
    const env = { TAMAPRINT_SAP_API_KEY: k1, FLEXOIMPRESOS_SAP_API_KEY: k2 }
    expect(resolveGatewayApiKey("tamaprint", env)).toBe(k1)
    expect(resolveGatewayApiKey("flexoimpresos", env)).toBe(k2)
  })
  it("sin llave del tenant: null (fail-closed, sin placeholder S2S_AUTH)", () => {
    // La llave de otro tenant ni MISSION_CONTROL_SECRET sirven de respaldo.
    expect(resolveGatewayApiKey("tamaprint", { FLEXOIMPRESOS_SAP_API_KEY: val("x") })).toBeNull()
    expect(resolveGatewayApiKey("tamaprint", { MISSION_CONTROL_SECRET: val("mc") })).toBeNull()
    expect(resolveGatewayApiKey("---", {})).toBeNull()
  })
})

describe("secreto interno (x-internal-secret)", () => {
  const canon = val("canon", "s")
  const legacy = val("legacy", "s")
  it("acepta el canónico y el alias MC_INTERNAL_SECRET a la vez", () => {
    const env = { MISSION_CONTROL_SECRET: canon, MC_INTERNAL_SECRET: legacy }
    expect(verifyInternalSecret(canon, env)).toBe(true)
    expect(verifyInternalSecret(legacy, env)).toBe(true)
    expect(verifyInternalSecret(val("otro"), env)).toBe(false)
  })
  it("solo el alias definido: funciona igual", () => {
    expect(verifyInternalSecret(legacy, { MC_INTERNAL_SECRET: legacy })).toBe(true)
  })
  it("vacío / null / sin secretos configurados: false", () => {
    expect(verifyInternalSecret("", { MISSION_CONTROL_SECRET: canon })).toBe(false)
    expect(verifyInternalSecret(null, { MISSION_CONTROL_SECRET: canon })).toBe(false)
    expect(verifyInternalSecret(canon, {})).toBe(false)
  })
  it("saliente: prefiere el canónico", () => {
    expect(getOutgoingInternalSecret({ MISSION_CONTROL_SECRET: canon, MC_INTERNAL_SECRET: legacy })).toBe(canon)
    expect(getOutgoingInternalSecret({ MC_INTERNAL_SECRET: legacy })).toBe(legacy)
  })
})

describe("anthropic: orden de fallback", () => {
  const t = val("tenant", "k")
  const a = val("ai4u", "k")
  const g = val("global", "k")
  it("tenant > global (orden previo intacto)", () => {
    const r = resolveAnthropicKey("tamaprint", { TAMAPRINT_ANTHROPIC_API_KEY: t, ANTHROPIC_API_KEY: g })
    expect([r.key, r.source, r.envName]).toEqual([t, "tenant", "TAMAPRINT_ANTHROPIC_API_KEY"])
  })
  it("sin la del tenant, la global con keySource 'global' (mismo valor de log que antes)", () => {
    const r = resolveAnthropicKey("flexoimpresos", { TAMAPRINT_ANTHROPIC_API_KEY: t, ANTHROPIC_API_KEY: g })
    expect([r.key, r.source, r.envName]).toEqual([g, "global", "ANTHROPIC_API_KEY"])
  })
  it("nivel nuevo del contrato: AI4U_ANTHROPIC_API_KEY entre tenant y global", () => {
    const r = resolveAnthropicKey("flexoimpresos", { AI4U_ANTHROPIC_API_KEY: a, ANTHROPIC_API_KEY: g })
    expect([r.key, r.source]).toEqual([a, "ai4u"])
  })
  it("id 'flexo' (alias de MC) resuelve a FLEXOIMPRESOS_", () => {
    const r = resolveAnthropicKey("flexo", { FLEXOIMPRESOS_ANTHROPIC_API_KEY: t })
    expect([r.key, r.envName]).toEqual([t, "FLEXOIMPRESOS_ANTHROPIC_API_KEY"])
  })
})
