-- Fase 1 de la auditoría del chat SAP (29-sep): trazabilidad de punta a punta.

-- 1) request_id = x-request-id del turno del chat. El backend lo reusa como su
--    requestId, así que une chat_tool_calls con platform_logs de ambos servicios.
ALTER TABLE public.chat_tool_calls ADD COLUMN IF NOT EXISTS request_id varchar(64);
CREATE INDEX IF NOT EXISTS chat_tool_calls_request_id_idx ON public.chat_tool_calls (request_id);

-- 2) Las cuentas master (acceso global) existen en auth.users pero no en
--    public.users: la FK rechazaba sus sesiones (23503) y su uso quedaba sin
--    historial. La identidad ya viene firmada por Mission Control (cookie mc_auth
--    → x-user-id, validado con x-internal-secret), así que user_id queda como uuid
--    simple. Se agrega índice para mantener las consultas por usuario.
ALTER TABLE public.chat_sessions DROP CONSTRAINT IF EXISTS chat_sessions_user_id_fkey;
CREATE INDEX IF NOT EXISTS chat_sessions_user_id_idx ON public.chat_sessions (user_id);
