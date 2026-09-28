-- chat_tool_calls guarda el input/output de las tools SAP (datos del ERP del
-- cliente) y se creó SIN RLS, a diferencia de chat_sessions/chat_messages que sí
-- lo tienen. Con RLS desactivado, cualquiera con la anon key pública (el bundle
-- de Mission Control la expone) podría leerla o escribirla por la API REST.
--
-- Sin políticas, solo service_role (sap-b1-chat, server-side, lib/supabase.ts) puede
-- acceder — que es exactamente el modelo que necesita: nadie más debe tocar esta tabla.
ALTER TABLE public.chat_tool_calls ENABLE ROW LEVEL SECURITY;
