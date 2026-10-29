import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

/**
 * The access/refresh pair lives in sessionStorage, not localStorage: closing the
 * tab ends the session, so a single XSS hit cannot hand over a long-lived token.
 * Moving to an httpOnly cookie requires proxying Supabase Auth through the Worker
 * and is tracked as a separate project, not a config flag.
 */
const sessionStore =
  typeof globalThis.sessionStorage === 'undefined' ? undefined : globalThis.sessionStorage;

/** Browser auth uses only the public publishable key. Authorization remains server-side. */
export const supabase =
  url && publishableKey
    ? createClient(url, publishableKey, {
        auth: {
          autoRefreshToken: true,
          persistSession: true,
          detectSessionInUrl: true,
          storage: sessionStore,
        },
      })
    : null;
