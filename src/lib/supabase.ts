import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

// Local-first: the app works fully off Dexie without Supabase configured.
// This is only used for cloud backup/sync once credentials are set in .env.local.
export const supabase = url && anonKey ? createClient(url, anonKey) : null;
