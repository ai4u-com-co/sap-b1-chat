"use client"

import { TYPOGRAPHY_TOKENS } from "@ai4u/design-system/tokens"
import { getToolName, type DynamicToolUIPart, type ToolUIPart } from "ai"
import { useId, useMemo, useState } from "react"
import { useElapsed } from "../hooks/useElapsed"
import {
  classifyToolSteps,
  humanToolError,
  type ClassifiedToolStep,
} from "@/lib/chat/ui/tool-step-status"

export type AnyToolPart = ToolUIPart | DynamicToolUIPart

const TOOL_LABELS: Record<string, string> = {
  consultar_sql:       "Consultando SQL SAP",
  obtener_documento:   "Obteniendo documento",
  listar_registros:    "Listando registros",
  crear_documento:     "Preparando documento",
  actualizar_documento: "Actualizando documento",
  ejecutar_accion:     "Ejecutando acción",
}

type PartView = {
  state: string
  output?: { sapDuration?: number; [k: string]: unknown } | string
  errorText?: string
  toolCallId?: string
}

function technicalDetail(part: AnyToolPart): string | undefined {
  const inv = part as unknown as PartView
  if (inv.output !== undefined) return typeof inv.output === "string" ? inv.output : JSON.stringify(inv.output, null, 2)
  return inv.errorText
}

// ─── ToolCallStep ─────────────────────────────────────────────────────────────
function ToolCallStep({
  part,
  step,
  toolStatusText,
  onRetry,
}: {
  part: AnyToolPart
  step: ClassifiedToolStep
  toolStatusText?: string
  onRetry?: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const detailId = useId()
  const inv = part as unknown as PartView

  const { status, retrying, error } = step
  const isRunning = status === "pendiente" && !retrying
  const isFailed = status === "fallido"
  const canExpand = status !== "pendiente"
  const elapsed = useElapsed(isRunning)

  const label = TOOL_LABELS[getToolName(part)] ?? getToolName(part)
  const sapDuration = typeof inv.output === "object" ? inv.output?.sapDuration : undefined
  const detail = technicalDetail(part)

  const icon = isFailed ? "!" : status === "ok" ? "✓" : status === "corregido" ? "↻" : "●"
  const iconColor = isFailed ? "var(--ai4u-error)" : status === "ok" ? "var(--ai4u-text-secondary)" : "var(--ai4u-cadet-gray)"

  return (
    <div style={ts.step} data-step-status={status}>
      <button
        type="button"
        style={ts.header}
        onClick={() => canExpand && setExpanded((v) => !v)}
        disabled={!canExpand}
        aria-expanded={canExpand ? expanded : undefined}
        aria-controls={canExpand ? detailId : undefined}
      >
        <span aria-hidden style={{ color: iconColor, fontWeight: isFailed ? 700 : undefined, animation: status === "pendiente" ? "pulse 1.4s ease-in-out infinite" : undefined }}>
          {icon}
        </span>
        <span style={ts.label}>{label}</span>

        {/* Error recuperable mientras el modelo sigue trabajando: neutro, no rojo */}
        {retrying && <span style={ts.meta}>reintentando…</span>}

        {/* Progreso en tiempo real (data-tool-status) */}
        {isRunning && toolStatusText && <span style={ts.statusText}>{toolStatusText}</span>}

        {/* Cronómetro cuando no hay status text */}
        {isRunning && !toolStatusText && elapsed > 0 && <span style={ts.metaMono}>{elapsed}s</span>}

        {/* Duración real SAP al completar */}
        {status === "ok" && sapDuration !== undefined && (
          <span style={ts.metaMono}>· {(sapDuration / 1000).toFixed(1)}s SAP</span>
        )}

        {canExpand && <span aria-hidden style={ts.meta}>{expanded ? "▲" : "▼"}</span>}
      </button>

      {expanded && canExpand && (
        <div id={detailId}>
          {error?.code && (
            <div style={ts.metaMono}>{error.code}{error.message ? ` — ${error.message}` : ""}</div>
          )}
          {detail !== undefined && <pre style={ts.output}>{detail}</pre>}
        </div>
      )}

      {isFailed && (
        <div style={ts.errorBox} role="status">
          <span style={{ flex: "1 1 180px", minWidth: 0 }}>{humanToolError(error)}</span>
          {error?.retryable === true && onRetry && (
            <button type="button" onClick={onRetry} style={ts.retryBtn}>↺ Reintentar</button>
          )}
          {error?.requestId && (
            <span style={ts.requestId} title="Código de referencia para soporte">Ref: {error.requestId}</span>
          )}
        </div>
      )}
    </div>
  )
}

// ─── ToolSteps: lista de pasos de un mensaje ─────────────────────────────────
/**
 * Renderiza los pasos de tool de un mensaje. Los pasos `corregido` (errores que
 * el modelo resolvió solo) se agrupan en un bloque neutro y plegado en la
 * posición del primero; solo `fallido` se pinta como error.
 */
export function ToolSteps({
  parts,
  toolStatusByCallId,
  streaming,
  onRetry,
}: {
  parts: AnyToolPart[]
  toolStatusByCallId: Map<string, string>
  streaming: boolean
  onRetry?: () => void
}) {
  const [groupOpen, setGroupOpen] = useState(false)
  const groupId = useId()

  const steps = useMemo(
    () =>
      classifyToolSteps(
        parts.map((p) => {
          const v = p as unknown as PartView
          return { toolCallId: v.toolCallId, toolName: getToolName(p), state: v.state, output: v.output, errorText: v.errorText }
        }),
        streaming,
      ),
    [parts, streaming],
  )

  if (parts.length === 0) return null

  // Un solo "Reintentar" por mensaje (regenera la respuesta completa): en el último fallido.
  const lastFailed = steps.map((s) => s.status).lastIndexOf("fallido")
  const corrected = steps.flatMap((s, i) => (s.status === "corregido" ? [i] : []))
  const firstCorrected = corrected[0]

  const renderStep = (i: number) => {
    const p = parts[i]
    const callId = (p as unknown as PartView).toolCallId ?? ""
    return (
      <ToolCallStep
        key={callId || i}
        part={p}
        step={steps[i]}
        toolStatusText={toolStatusByCallId.get(callId)}
        onRetry={i === lastFailed ? onRetry : undefined}
      />
    )
  }

  return (
    <div style={ts.list}>
      {parts.map((_, i) => {
        if (steps[i].status !== "corregido") return renderStep(i)
        if (i !== firstCorrected) return null
        const n = corrected.length
        return (
          <div key={`corregidos-${i}`} style={ts.group} data-testid="tool-steps-corrected">
              <button
                type="button"
                style={ts.groupToggle}
                onClick={() => setGroupOpen((v) => !v)}
                aria-expanded={groupOpen}
                aria-controls={groupId}
              >
                <span aria-hidden style={{ color: "var(--ai4u-cadet-gray)" }}>↻</span>
                <span style={ts.label}>Ajustó la consulta {n} {n === 1 ? "vez" : "veces"}</span>
                <span aria-hidden style={ts.meta}>{groupOpen ? "▲" : "▼"}</span>
              </button>
              {groupOpen && (
                <div id={groupId} style={ts.groupBody}>
                  <p style={ts.groupHint}>El asistente corrigió estos pasos por su cuenta; no afectan la respuesta.</p>
                  {corrected.map(renderStep)}
                </div>
              )}
          </div>
        )
      })}
    </div>
  )
}

// ─── Estilos (solo tokens del design system) ─────────────────────────────────
const ts: Record<string, React.CSSProperties> = {
  list: { display: "flex", flexDirection: "column", gap: 4, marginBottom: 10, borderLeft: "2px solid var(--ai4u-border-color)", paddingLeft: 10, minWidth: 0 },
  step: { fontSize: 12, color: "var(--ai4u-text-secondary)", minWidth: 0 },
  header: { display: "flex", alignItems: "center", gap: 6, background: "transparent", border: "none", cursor: "pointer", fontFamily: "inherit", fontSize: 12, color: "var(--ai4u-text-secondary)", padding: "3px 0", width: "100%", textAlign: "left", minWidth: 0 },
  label: { flex: 1, minWidth: 0, textAlign: "left", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  meta: { fontSize: 12, color: "var(--ai4u-cadet-gray)", flexShrink: 0 },
  metaMono: { fontSize: 12, color: "var(--ai4u-cadet-gray)", fontFamily: TYPOGRAPHY_TOKENS.fontFamily.code, overflowWrap: "anywhere" },
  statusText: { fontSize: 12, color: "var(--ai4u-cadet-gray)", fontStyle: "italic", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  output: { fontSize: 12, fontFamily: TYPOGRAPHY_TOKENS.fontFamily.code, background: "var(--ai4u-bg-surface)", borderRadius: 6, padding: "8px 10px", maxHeight: 200, overflowY: "auto", marginTop: 4, color: "var(--ai4u-text-secondary)", whiteSpace: "pre-wrap", overflowWrap: "anywhere" },
  errorBox: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, marginTop: 4, padding: "8px 10px", fontSize: 13, color: "var(--ai4u-text-primary)", background: "var(--ai4u-hot-orange-5)", border: "1px solid var(--ai4u-hot-orange-30)", borderRadius: 8 },
  retryBtn: { background: "transparent", border: "1px solid var(--ai4u-hot-orange-30)", borderRadius: 8, color: "var(--ai4u-error)", fontSize: 13, cursor: "pointer", fontFamily: "inherit", minHeight: 44, padding: "0 14px", flexShrink: 0 },
  requestId: { flexBasis: "100%", fontSize: 12, color: "var(--ai4u-cadet-gray)", fontFamily: TYPOGRAPHY_TOKENS.fontFamily.code, overflowWrap: "anywhere" },
  group: { borderRadius: 8, border: "1px solid var(--ai4u-border-color)", minWidth: 0 },
  groupToggle: { display: "flex", alignItems: "center", gap: 6, width: "100%", minHeight: 44, background: "transparent", border: "none", cursor: "pointer", padding: "0 10px", fontSize: 12, color: "var(--ai4u-text-secondary)", fontFamily: "inherit", textAlign: "left" },
  groupBody: { display: "flex", flexDirection: "column", gap: 4, padding: "0 10px 8px", minWidth: 0 },
  groupHint: { margin: "0 0 4px", fontSize: 12, color: "var(--ai4u-cadet-gray)" },
}
