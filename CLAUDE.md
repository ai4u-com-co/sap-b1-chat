# SAP B1 Chat — Developer Guide

Next.js 16 · React 19 · Vercel AI SDK v6 · `@ai4u/design-system` (tokens). Dev en `:4101`.

> Arquitectura completa, auth y variables de entorno: ver `README.md`.

## Scripts
- `npm run dev` — dev server
- `npm run build` — build de producción
- `npm run type-check` — `tsc --noEmit`

## Versionado — obligatorio antes de cada commit

El historial vive en el **changelog-service central**, no en este repo.

**Flujo antes de cada commit:**

```
MCP tool: add_changelog_entry({
  clientId: "ai4u",
  appId: "sap-b1-chat",
  appName: "SAP B1 Chat",   // solo la primera vez
  bump: "patch",            // "patch" | "minor" | "major"
  date: "YYYY-MM-DD",
  changes: [
    "feat: descripción del cambio",
    "fix: otro cambio si aplica"
  ]
})
```

`bump` calcula la versión automáticamente a partir de la anterior.

**Cuándo usar cada bump:**
- `patch` — fix, chore, refactor, ajuste menor
- `minor` — feat nueva visible para el usuario
- `major` — breaking change o release significativo

**Prefijos de cambios:** `feat:` `fix:` `refactor:` `chore:`
