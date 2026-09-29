import { safeEqual } from "@ai4u/platform/security"
import { readEnv, type EnvSource } from "@/lib/env"

/**
 * Secreto interno compartido con mission-control-main. MISSION_CONTROL_SECRET
 * es el nombre canónico del ecosistema (contrato de env v1); MC_INTERNAL_SECRET
 * es un alias legacy que se acepta mientras se retira de Vercel.
 *
 * Se aceptan AMBOS valores a la vez (comportamiento previo): readEnv del canónico
 * (que ya cae al alias con aviso si el canónico falta) + el alias leído aparte, por
 * si los dos están definidos con valores distintos durante una rotación.
 */
export function candidates(env?: EnvSource): string[] {
  const all = [readEnv("MISSION_CONTROL_SECRET", env), readEnv("MC_INTERNAL_SECRET", env)]
  return [...new Set(all.filter((s): s is string => Boolean(s)))]
}

/** Compara en tiempo constante (safeEqual de @ai4u/platform) contra cualquiera de los secretos aceptados. */
export function verifyInternalSecret(received: string | null | undefined, env?: EnvSource): boolean {
  if (!received) return false
  try {
    // `some` corta en el primer acierto: el tiempo solo revela CUÁL candidato
    // coincidió (canónico o alias), nunca el contenido del secreto.
    return candidates(env).some((expected) => safeEqual(received, expected))
  } catch {
    return false
  }
}

/** Secreto a mandar en llamadas salientes hacia mission-control-main (prefiere el nombre canónico). */
export function getOutgoingInternalSecret(env?: EnvSource): string | undefined {
  return candidates(env)[0]
}
