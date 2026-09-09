-- Fix #2 del incidente 2026-08-31 (tenant flexoimpresos, rid=398894ad):
-- `onFinish` (app/api/chat/route.ts) es el único lugar que persistía algo en
-- Supabase, y solo corría si el turno completaba. Un turno que muere a mitad
-- (timeout de una tool SAP, o cualquier otro fallo que mate el stream) no
-- dejaba ningún rastro server-side de qué tool se alcanzó a llamar.
--
-- Esta tabla recibe una fila por cada tool call apenas termina (éxito o
-- error), vía `experimental_onToolCallFinish` de streamText — ver
-- lib/chat/tool-call-log.ts. Es best-effort (nunca bloquea ni rompe el turno
-- si la inserción falla) y NO reemplaza `chat_messages.tool_calls`/
-- `tool_results` (que sigue guardando el resumen final del turno completo
-- cuando SÍ completa) — esta tabla es la única fuente de verdad para un turno
-- que NO completó.
--
-- NOTA: este repo (sap-b1-chat) no tenía carpeta supabase/migrations hasta
-- ahora — es la primera migración versionada acá. `chat_sessions`/
-- `chat_messages` (creadas en mission-control-main, init_schema.sql) NO tienen
-- RLS habilitado, y sap-b1-chat escribe con la ANON key (ver lib/supabase.ts)
-- — esta tabla sigue la misma postura de seguridad que sus tablas hermanas
-- para no romper ese flujo. No es un endurecimiento de RLS del proyecto en
-- general; eso queda fuera de alcance de este fix.
--
-- PASO HUMANO: esta migración NO fue aplicada a producción. Aplicar con
-- `supabase db push` (o el mecanismo que use el proyecto Supabase real de
-- mission-control) antes de que experimental_onToolCallFinish empiece a
-- insertar filas — hasta entonces, el insert falla silenciosamente
-- (best-effort, capturado en logToolCallResult) y el fix #2 queda sin efecto
-- aunque el fix #1 (timeout) ya funcione.

CREATE TABLE IF NOT EXISTS public.chat_tool_calls (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES public.chat_sessions(id) ON DELETE CASCADE,
    tenant_id VARCHAR(255) NOT NULL,
    tool_name VARCHAR(255) NOT NULL,
    tool_call_id VARCHAR(255) NOT NULL,
    step_number INTEGER,
    duration_ms INTEGER NOT NULL,
    success BOOLEAN NOT NULL,
    input JSONB,
    output JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

CREATE INDEX IF NOT EXISTS chat_tool_calls_session_id_idx ON public.chat_tool_calls (session_id, created_at);
CREATE INDEX IF NOT EXISTS chat_tool_calls_tenant_id_idx ON public.chat_tool_calls (tenant_id, created_at);
