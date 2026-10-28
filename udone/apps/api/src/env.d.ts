declare global {
  interface Env {
    APP_VERSION: string;
    CF_VERSION_METADATA?: WorkerVersionMetadata;
    SUPABASE_URL: string;
    SUPABASE_PUBLISHABLE_KEY: string;
    SUPABASE_SERVICE_ROLE_KEY: string;
    ASSETS: Fetcher;
  }
}

export {};
