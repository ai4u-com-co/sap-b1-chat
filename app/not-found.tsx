import Link from "next/link"

export default function NotFound() {
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
      <h1 style={{ fontSize: "1.25rem", fontWeight: 600 }}>Página no encontrada</h1>
      <p style={{ color: "#666", maxWidth: 420 }}>
        La página que buscas no existe o fue movida.
      </p>
      <Link
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
      </Link>
    </div>
  )
}
