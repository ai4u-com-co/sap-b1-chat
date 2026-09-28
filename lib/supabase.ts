import { createClient } from "@supabase/supabase-js"

// SOLO servidor. Usa service role porque chat_sessions/chat_messages tienen RLS
// activo sin políticas (la anon key no puede escribir) y las escrituras las hace
// este backend en nombre de un usuario ya autenticado por Mission Control
// (x-internal-secret + x-user-id). Nunca importar desde un componente de cliente:
// la service role saltaría todo RLS si llegara al bundle del navegador.
//
// Variables (Vercel, proyecto sap-b1-chat): SUPABASE_URL (o NEXT_PUBLIC_SUPABASE_URL,
// que no es secreta) y SUPABASE_SERVICE_ROLE_KEY (Sensitive). Sin ellas el cliente
// es `null` y la persistencia queda deshabilitada (lib/chat/persistence.ts lo avisa).
const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

export const supabase =
  supabaseUrl && serviceRoleKey
    ? createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } })
    : null
