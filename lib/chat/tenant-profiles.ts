export type TenantId = string

export interface TenantProfile {
  nombre: string
  industria: string
  pais: string
  moneda: string
  periodoFiscal: string
  lineasNegocio: string[]
  glosario: Record<string, string>
  modulosActivos: string[]
  /**
   * Fechas (YYYY-MM-DD) que se excluyen de las estadísticas de venta (saldos
   * iniciales de migración). Espejo EXACTO de `excludedDates` del tenant en
   * mission-control (lib/tenants/<tenant>.ts): Mission Control las manda en cada
   * request a /kpis, /insights/*, /finance/pnl, etc. — si el chat no manda las
   * mismas, sus cifras no cuadran con Pulse. Si cambian allá, cambiarlas acá.
   */
  excludedDates?: string[]
}

export const TENANT_PROFILES: Record<TenantId, TenantProfile> = {
  tamaprint: {
    nombre: "Tamaprint S.A.S.",
    industria: "Impresión comercial y producción gráfica",
    pais: "Colombia",
    moneda: "COP",
    periodoFiscal: "Enero – Diciembre",
    lineasNegocio: ["Offset", "Digital", "Gran formato", "Acabados"],
    glosario: {
      tecnología: "familia de artículos / grupo de ítem (OITM.ItmsGrpCod; nombres vía datos maestros del contexto SAP)",
      tiraje: "cantidad de impresiones por trabajo",
    },
    modulosActivos: [
      "compras",
      "ventas",
      "inventario",
      "socios",
      "pagos",
      "contabilidad",
      "produccion",
      "sistema",
      "rrhh",
    ],
  },
  flexoimpresos: {
    nombre: "FlexoImpresos S.A.S.",
    industria: "Impresión flexográfica y empaques flexibles",
    pais: "Colombia",
    moneda: "COP",
    periodoFiscal: "Enero – Diciembre",
    lineasNegocio: ["Flexografía", "Etiquetas", "Empaques flexibles"],
    glosario: {
      sustrato: "familia de material / grupo de ítem (tipo de lámina o papel)",
      "ancho de bobina": "campo de medida en la descripción del ítem",
    },
    modulosActivos: [
      "compras",
      "ventas",
      "inventario",
      "socios",
      "pagos",
      "contabilidad",
      "sistema",
    ],
    // mission-control lib/tenants/flexo.ts: saldos iniciales cargados el 1-ene-2026.
    excludedDates: ["2026-01-01"],
  },
  magdalena: {
    nombre: "La Magdalena",
    industria: "Arte, memoria visual y biodiversidad de Colombia",
    pais: "Colombia",
    moneda: "COP",
    periodoFiscal: "Enero – Diciembre",
    lineasNegocio: ["Fotografía editorial", "Libro Jarupia", "Curaduría cultural"],
    glosario: {
      jarupia: "libro de biodiversidad y memoria visual de Colombia",
      pieza: "obra fotográfica o editorial de edición limitada",
    },
    modulosActivos: ["advisor", "social-listening", "share-of-voice", "proyeccion"],
  },
}

export function getTenantProfile(tenant: TenantId): TenantProfile {
  const profile = TENANT_PROFILES[tenant]
  if (!profile) throw new Error(`Tenant desconocido: "${tenant}"`)
  return profile
}
