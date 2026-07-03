import { createClient, SupabaseClient } from "@supabase/supabase-js";

let adminClient: SupabaseClient | null = null;
let anonClient: SupabaseClient | null = null;

/**
 * Service-role client. Bypasses RLS — used only in server-only code paths:
 * the sync pipeline (writes to content_chunks/sync_logs) and analytics
 * logging. NEVER import this into client components or expose the key
 * via NEXT_PUBLIC_*.
 */
export function getSupabaseAdmin(): SupabaseClient {
  if (adminClient) return adminClient;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase admin env vars are not set (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)");
  adminClient = createClient(url, key, { auth: { persistSession: false } });
  return adminClient;
}

/**
 * Anon-key client, safe under RLS for read-only access (content_chunks
 * select + match_content_chunks RPC). Used server-side in the chat API
 * route since the anon key is public by design.
 */
export function getSupabaseAnon(): SupabaseClient {
  if (anonClient) return anonClient;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("Supabase anon env vars are not set (NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY)");
  anonClient = createClient(url, key, { auth: { persistSession: false } });
  return anonClient;
}
