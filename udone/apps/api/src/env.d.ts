declare global {
  interface Env {
    APP_VERSION: string;
    CF_VERSION_METADATA?: WorkerVersionMetadata;
    SUPABASE_URL: string;
    SUPABASE_PUBLISHABLE_KEY: string;
    SUPABASE_SERVICE_ROLE_KEY: string;
    /** Comma-separated allowlist for cross-origin browser clients. Wildcards are rejected. */
    ALLOWED_ORIGINS?: string;
    /** Global per-IP request ceiling used by the rate-limit middleware. */
    RATE_LIMIT_PER_MINUTE?: string;
    ASSETS: Fetcher;
  }
}

export {};
