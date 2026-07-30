import type { BackendClient } from "@ai4u/contracts"

export interface Warehouse { code: string; name: string }
export interface SalesPerson { code: number; name: string }
export interface CostCenter { code: string; name: string }
export interface ItemGroup { code: number; name: string }
export interface CustomField { table: string; fieldId: string; name: string; description: string }

export interface SapContext {
  almacenes: Warehouse[]
  vendedores: SalesPerson[]
  centrosCosto: CostCenter[]
  gruposItem: ItemGroup[]
  camposPersonalizados: CustomField[]
}

const RELEVANT_TABLES = [
  "OINV","INV1","ORDR","RDR1","OPOR","POR1","OPCH","PCH1","OPDN","PDN1",
  "OITM","OCRD","ORCT","OJDT",
]

interface CacheEntry { context: SapContext; expiresAt: number }
// Cache en memoria (Map de módulo), TTL 1h. Best-effort, NO compartido entre
// instancias serverless de Vercel: cada cold start empieza en frío y vuelve a
// traer los maestros SAP una vez. Deliberadamente no se migró a un cache
// externo compartido (Vercel KV/Upstash Redis) porque eso requiere provisionar
// infra + secretos nuevos, que en este ecosistema exigen autorización humana
// explícita (ver reglas de "Credenciales, permisos y pasos manuales" en
// CLAUDE.md) — no algo para decidir de forma unilateral en un refactor de
// cache. Si el costo de los cold starts se vuelve un problema medido (no
// especulado), ahí sí vale la pena abrir esa conversación con el equipo.
const cache = new Map<string, CacheEntry>()
const TTL_MS = 60 * 60 * 1000

async function safeGet<T>(client: BackendClient, path: string): Promise<T[]> {
  try {
    const res = await client.get<{ value?: T[] }>(path)
    return res.value ?? []
  } catch {
    return []
  }
}

export async function fetchSapContext(client: BackendClient, tenant: string): Promise<SapContext> {
  const cached = cache.get(tenant)
  if (cached && cached.expiresAt > Date.now()) return cached.context

  const tablesFilter = RELEVANT_TABLES.map((t) => `TableName eq '${t}'`).join(" or ")

  const [rawWh, rawSlp, rawCC, rawIG, rawCF] = await Promise.all([
    safeGet<{ WarehouseCode: string; WarehouseName: string }>(
      client, `/odata?path=${encodeURIComponent("/Warehouses?$select=WarehouseCode,WarehouseName&$top=200")}`
    ),
    safeGet<{ SalesEmployeeCode: number; SalesEmployeeName: string }>(
      client, `/odata?path=${encodeURIComponent("/SalesPersons?$select=SalesEmployeeCode,SalesEmployeeName&$top=200")}`
    ),
    safeGet<{ CenterCode: string; CenterName: string }>(
      client, `/odata?path=${encodeURIComponent("/ProfitCenters?$select=CenterCode,CenterName&$top=200")}`
    ),
    safeGet<{ Number: number; GroupName: string }>(
      client, `/odata?path=${encodeURIComponent("/ItemGroups?$select=Number,GroupName&$top=200")}`
    ),
    safeGet<{ TableName: string; FieldID: string; Name: string; Description: string }>(
      client, `/odata?path=${encodeURIComponent(`/UserFieldsMD?$select=TableName,FieldID,Name,Description&$filter=${tablesFilter}&$top=500`)}`
    ),
  ])

  const context: SapContext = {
    almacenes: rawWh.map((w) => ({ code: w.WarehouseCode, name: w.WarehouseName })),
    vendedores: rawSlp.filter((s) => s.SalesEmployeeCode > 0).map((s) => ({ code: s.SalesEmployeeCode, name: s.SalesEmployeeName })),
    centrosCosto: rawCC.map((c) => ({ code: c.CenterCode, name: c.CenterName })),
    gruposItem: rawIG.map((g) => ({ code: g.Number, name: g.GroupName })),
    camposPersonalizados: (() => {
      const tableCount = new Map<string, number>()
      return rawCF
        .filter((f) => f.FieldID && f.TableName)
        .reduce<CustomField[]>((acc, f) => {
          const count = tableCount.get(f.TableName) ?? 0
          if (count >= 40) return acc
          tableCount.set(f.TableName, count + 1)
          acc.push({ table: f.TableName, fieldId: `U_${f.FieldID}`, name: f.Name ?? f.FieldID, description: f.Description ?? "" })
          return acc
        }, [])
    })(),
  }

  cache.set(tenant, { context, expiresAt: Date.now() + TTL_MS })
  return context
}
