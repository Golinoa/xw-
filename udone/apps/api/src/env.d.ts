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
    /**
     * 本地/CI 的自签令牌通道。只认字符串 'true'，生产禁止设置。
     * 不能拿 SUPABASE_JWT_SECRET 是否存在当开关——生产也配它。
     */
    ALLOW_LOCAL_JWT_AUTH?: string;
    ASSETS: Fetcher;
  }
}

export {};
