# SAP B1 Chat

Asistente conversacional con IA para consultar y operar **SAP Business One** en lenguaje natural. Se accede desde Mission Control (SSO) y proxea contra `sap-b1-backend`, que ejecuta las herramientas SAP.

**Stack:** Next.js 16 · React 19 · Vercel AI SDK v6 · `@ai4u/design-system` (tokens) · Dev en `:4101`

---

## Arquitectura

```
Mission Control → /api/mc-auth?token=... → cookie de sesión (8h)
                                              │
   UI de chat ── /api/chat ──┐                │ resuelve API key
                /api/suggestions ├─ session.ts ┘ server-side
                /api/me ─────────┘
                       │ X-API-Key (server-side)
                       ▼
                 sap-b1-backend /api/v1/chat
                       ▼
                 SAP B1 Service Layer
```

### Seguridad — API key 100% server-side
La API key de SAP **nunca** llega al cliente ni a la URL. El flujo:
1. MC abre `/api/mc-auth?token=...` (token firmado, 5 min)
2. Se valida y se setea una cookie de sesión firmada (`mc_session`, con expiry)
3. `app/lib/session.ts` resuelve la API key desde la sesión: `{TENANT}_SAP_API_KEY`. Si el tenant SAP no la tiene, la ruta responde 401 sin llamar al gateway (ya no existe el respaldo `"S2S_AUTH"` + `x-mc-secret`). Los tenants proxy (magdalena) no la necesitan.
4. Las rutas API (`/api/chat`, `/api/suggestions`, `/api/me`) leen la key del servidor

`proxy.ts` (convención de Next 16; gate en `lib/session-gate.ts`, siempre runtime Node) protege `/api/*`: exige cookie de sesión válida o `x-internal-secret` de Mission Control (S2S). Públicas: `/api/mc-auth` (handoff SSO) y `/api/changelog`. En producción falla cerrado (500) si falta `MISSION_CONTROL_SECRET`. Cada handler vuelve a validar la sesión (defensa en profundidad).

### Features
- **Multi-hilo** con persistencia en localStorage (`useThreads`)
- **Streaming** de respuestas (UI message stream protocol)
- **Sugerencias** de preguntas estratégicas por tenant (cache diario bindeado a tenant)
- **Changelog** integrado (modal)

---

## Variables de entorno

| Variable | Descripción |
|---|---|
| `MISSION_CONTROL_SECRET` | Valida tokens SSO de MC (mismo valor que en MC) |
| `{TENANT}_SAP_API_KEY` | API key que el chat envía al backend (ej: `TAMAPRINT_SAP_API_KEY`) |
| `SAP_BACKEND_URL` | URL del sap-b1-backend. En Vercel es una **Shared Env Var del team** (no hace falta copia propia en el proyecto). La misma URL la usan `/api/me` y `BackendClient` (se le pasa como `baseUrl`). `BACKEND_URL` / `NEXT_PUBLIC_BACKEND_URL` son **alias legados** (se aceptan con aviso). En local, sin ninguna, `http://localhost:4100`; en producción, sin ninguna → 503 |
| `CHANGELOG_URL` | URL del changelog del proyecto |
| `SUPABASE_URL` | URL del proyecto Supabase donde se guarda el historial (`NEXT_PUBLIC_SUPABASE_URL` sirve de respaldo; no es secreta) |
| `SUPABASE_SERVICE_ROLE_KEY` | **Secreta, solo servidor.** Sin ella la persistencia de `chat_sessions`/`chat_messages`/`chat_tool_calls` queda deshabilitada (y `platform_logs` lo avisa una vez). Se usa service role porque esas tablas tienen RLS sin políticas |

Ver `.env.example`.

---

## Scripts
- `npm run dev` — dev server en `:4101` (Turbopack)
- `npm run build` — build de producción
- `npm run type-check` — `tsc --noEmit`

## Acceso en desarrollo
El chat solo es accesible con sesión válida. En dev (sin `MISSION_CONTROL_SECRET`) el `proxy.ts` permite acceso. Para probar el flujo completo, accede vía Mission Control.
