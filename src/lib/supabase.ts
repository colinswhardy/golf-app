import { createClient } from "@supabase/supabase-js";

// The CaddyShot cloud backup lives in the personal Supabase project (ca-central-1), in its own
// RLS-guarded caddyshot_rows table. The publishable key is DESIGNED to ship in client code —
// every row is locked to auth.uid() by row-level security, so the key alone reads nothing.
// Env vars still win when set, so a different project can be pointed at without a code change.
const DEFAULT_URL = "https://flwzhavwubgniepiwnqt.supabase.co";
const DEFAULT_PUBLISHABLE_KEY = "sb_publishable_goCDpfYoolFIqfCVDUkXMw_10c2xGxb";

const url = import.meta.env.VITE_SUPABASE_URL || DEFAULT_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY || DEFAULT_PUBLISHABLE_KEY;

// Local-first: the app works fully off Dexie without Supabase reachable. This client only backs
// the cloud-backup path in lib/sync.ts.
export const supabase = url && key ? createClient(url, key) : null;
