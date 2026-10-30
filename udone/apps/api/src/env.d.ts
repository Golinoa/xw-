declare global {
  interface Env {
    APP_VERSION: string;
    CF_VERSION_METADATA?: WorkerVersionMetadata;
    SUPABASE_URL: string;
    SUPABASE_PUBLISHABLE_KEY: string;
    SUPABASE_SERVICE_ROLE_KEY: string;
    /**
     * 幂等键的签名密钥。生产必配，但不设为必填类型：本地与 CI 没有 GoTrue 时也能起服务，
     * 只是幂等命名空间会退化（见 middleware/idempotency.ts 的告警）。
     * 「配了与没配」在部署日志里长得一样，所以 check:deploy 盯的是这个名字在不在样例里。
     */
    SUPABASE_JWT_SECRET?: string;
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
