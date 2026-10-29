import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const createClient = vi.fn<(...args: unknown[]) => unknown>();
createClient.mockReturnValue({ auth: { mocked: true } });

vi.mock('@supabase/supabase-js', () => ({ createClient }));

type AuthOptions = {
  storage?: unknown;
  persistSession?: boolean;
  autoRefreshToken?: boolean;
  detectSessionInUrl?: boolean;
};

function authOptions(): AuthOptions {
  const args = createClient.mock.calls[0] as unknown[] | undefined;
  const options = args?.[2] as { auth?: AuthOptions } | undefined;
  return options?.auth ?? {};
}

function fakeStorage() {
  return { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() };
}

async function importClient() {
  vi.resetModules();
  return import('./supabase');
}

describe('supabase browser client', () => {
  beforeEach(() => {
    createClient.mockClear();
    vi.stubEnv('VITE_SUPABASE_URL', 'https://project.supabase.co');
    vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_test_only');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('keeps the auth session in sessionStorage instead of localStorage', async () => {
    const storage = fakeStorage();
    vi.stubGlobal('sessionStorage', storage);

    const { supabase } = await importClient();

    expect(supabase).not.toBeNull();
    expect(authOptions().storage).toBe(storage);
  });

  it('still refreshes tokens across a tab session', async () => {
    vi.stubGlobal('sessionStorage', fakeStorage());

    await importClient();

    const auth = authOptions();
    expect(auth.persistSession).toBe(true);
    expect(auth.autoRefreshToken).toBe(true);
    expect(auth.detectSessionInUrl).toBe(true);
  });

  it('exposes null when the project is not configured', async () => {
    vi.unstubAllEnvs();
    vi.stubEnv('VITE_SUPABASE_URL', '');
    vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', '');

    const { supabase } = await importClient();

    expect(supabase).toBeNull();
    expect(createClient).not.toHaveBeenCalled();
  });
});
