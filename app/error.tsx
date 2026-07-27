"use client"

import { useEffect } from "react"

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error("[error]", error)
  }, [error])

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "60vh",
        textAlign: "center",
        padding: "1rem",
        gap: "0.75rem",
      }}
    >
      <h1 style={{ fontSize: "1.25rem", fontWeight: 600 }}>Algo salió mal</h1>
      <p style={{ color: "#666", maxWidth: 420 }}>
        Ocurrió un error inesperado. Puedes reintentar o volver al inicio.
      </p>
      {error.digest && (
        <p style={{ fontSize: "0.75rem", color: "#999", fontFamily: "monospace" }}>
          Código: {error.digest}
        </p>
      )}
      <div style={{ display: "flex", gap: "0.75rem", marginTop: "0.5rem" }}>
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- deliberado:
            tras un error de render, queremos una recarga completa (limpia cualquier
            estado de React que haya quedado roto), no navegación client-side de next/link */}
        <a
          href="/"
          style={{
            padding: "0.5rem 1.25rem",
            border: "1px solid #ccc",
            borderRadius: "4px",
            textDecoration: "none",
            color: "#111",
          }}
        >
          Volver al inicio
        </a>
        <button
          onClick={reset}
          style={{
            padding: "0.5rem 1.25rem",
            background: "#1976d2",
            color: "#fff",
            border: "none",
            borderRadius: "4px",
            cursor: "pointer",
          }}
        >
          Reintentar
        </button>
      </div>
    </div>
  )
}
