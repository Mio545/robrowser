/**
 * Server credential vault (AES-256-GCM file backend).
 *
 * These tests pin the security-relevant behaviour: the password never appears
 * in the file, a blank write keeps the stored password, and a wrong key fails
 * loudly instead of returning garbage.
 */
import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pino } from 'pino';
import { FileCredentialStore } from './credentials.js';

const logger = pino({ level: 'silent' });

/** A throwaway vault path inside a fresh temp directory. */
async function vaultPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'robrowser-cred-'));
  return join(dir, 'credentials.json');
}

describe('FileCredentialStore', () => {
  it('round-trips a credential without writing the password in the clear', async () => {
    const file = await vaultPath();
    const store = new FileCredentialStore({ file, key: 'unit-test-key', logger });

    await store.set({
      key: 'github',
      username: 'octocat',
      password: 'p@ssw0rd-supersecret',
      url: 'https://github.com/login',
    });

    const stored = await store.get('github');
    expect(stored).toEqual({
      key: 'github',
      username: 'octocat',
      password: 'p@ssw0rd-supersecret',
      url: 'https://github.com/login',
      updatedAt: expect.any(String),
    });

    // The raw file must contain the username but never the password.
    const raw = await readFile(file, 'utf8');
    expect(raw).toContain('octocat');
    expect(raw).not.toContain('p@ssw0rd-supersecret');
  });

  it('keeps the stored password when a later write omits it', async () => {
    const file = await vaultPath();
    const store = new FileCredentialStore({ file, key: 'k', logger });
    await store.set({ key: 'login', username: 'old', password: 'secret-1' });

    // Simulates "edit the username, leave the password box empty".
    await store.set({ key: 'login', username: 'new' });

    const stored = await store.get('login');
    expect(stored?.username).toBe('new');
    expect(stored?.password).toBe('secret-1');
  });

  it('refuses to store a password when no key is configured', async () => {
    const file = await vaultPath();
    const store = new FileCredentialStore({ file, logger });
    await expect(store.set({ key: 'login', password: 'secret' })).rejects.toThrow(
      /ROBO_CREDENTIALS_KEY/,
    );
    // Username-only credentials are still allowed.
    await expect(store.set({ key: 'login', username: 'octocat' })).resolves.toMatchObject({
      key: 'login',
      username: 'octocat',
    });
  });

  it('fails loudly when decrypted with a different key', async () => {
    const file = await vaultPath();
    await new FileCredentialStore({ file, key: 'first', logger }).set({
      key: 'login',
      password: 'secret',
    });
    const other = new FileCredentialStore({ file, key: 'second', logger });
    await expect(other.get('login')).rejects.toThrow(/解密/);
  });

  it('lists redacted metadata and deletes entries', async () => {
    const file = await vaultPath();
    const store = new FileCredentialStore({ file, key: 'k', logger });
    await store.set({ key: 'b', username: 'bee', password: 'x' });
    await store.set({ key: 'a', username: 'aye', password: 'y' });

    const list = await store.list();
    expect(list.map((item) => item.key)).toEqual(['a', 'b']);
    expect(list[0]).not.toHaveProperty('password');

    expect(await store.delete('a')).toBe(true);
    expect(await store.delete('a')).toBe(false);
    expect((await store.list()).map((item) => item.key)).toEqual(['b']);
  });
});
