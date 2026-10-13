/**
 * Desktop credential vault (spec 9).
 *
 * Passwords are encrypted with Electron `safeStorage`, which is backed by the
 * OS keychain (DPAPI on Windows, Keychain on macOS, libsecret on Linux), and
 * only the ciphertext ever reaches SQLite. The plaintext never touches the flow
 * document, the run summary, the checkpoint or an exported script — that is
 * what makes `{ type: "credential" }` safe to commit to a repository.
 *
 * There is deliberately no plaintext fallback: when the keychain is
 * unavailable, saving a *password* fails with an actionable error. Usernames
 * and URLs stay readable so the UI can still show which logins exist.
 */
import { safeStorage } from 'electron';
import type { Logger } from 'pino';
import {
  InMemoryCredentialStore,
  normalizeCredential,
  type CredentialInput,
  type CredentialRecord,
  type CredentialStore,
  type CredentialSummary,
} from '@robrowser/core';
import type { DesktopStorage, StoredCredentialRow } from './storage.js';

/** Desktop {@link CredentialStore}: OS-keychain-encrypted SQLite rows. */
export class DesktopCredentialVault implements CredentialStore {
  public constructor(
    private readonly storage: DesktopStorage,
    private readonly logger: Logger,
  ) {}

  /** True when the OS keychain can encrypt a password right now. */
  public get encryptionAvailable(): boolean {
    try {
      return safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  public async get(key: string): Promise<CredentialRecord | undefined> {
    const row = this.storage.getCredential(key);
    return row ? this.materialize(row) : undefined;
  }

  public async set(input: CredentialInput): Promise<CredentialRecord> {
    const record = normalizeCredential(input);
    const now = new Date().toISOString();

    // Keep the previous ciphertext when the form leaves the password blank:
    // that is how the UI expresses 'keep the stored password'.
    const previous = this.storage.getCredential(record.key);
    const secret = this.encrypt(record, previous);

    this.storage.saveCredential({
      key: record.key,
      username: record.username,
      secret,
      url: record.url,
      updatedAt: now,
    });
    return { ...record, updatedAt: now };
  }

  public async delete(key: string): Promise<boolean> {
    return this.storage.deleteCredential(key);
  }

  public async list(): Promise<CredentialSummary[]> {
    return this.storage.listCredentials();
  }

  /**
   * Encrypt the password for storage.
   *
   * @returns `undefined` when there is no password to store (username-only
   *   credential), otherwise the keychain ciphertext. Reuses the previous blob
   *   when the caller omitted the password.
   */
  private encrypt(
    record: CredentialRecord,
    previous: StoredCredentialRow | undefined,
  ): Buffer | undefined {
    if (record.password === undefined) {
      // No new password supplied: preserve whatever was already stored.
      return previous?.secret;
    }
    if (!this.encryptionAvailable) {
      throw new Error(
        '系统凭据库不可用，无法安全保存密码。请确认已登录操作系统账户后重试，' +
          '或仅填写用户名（不含密码）。',
      );
    }
    return safeStorage.encryptString(record.password);
  }

  /** Decrypt a stored row into the shape the variable store consumes. */
  private materialize(row: StoredCredentialRow): CredentialRecord {
    return {
      key: row.key,
      ...(row.username !== undefined ? { username: row.username } : {}),
      ...(row.secret !== undefined && row.secret.length > 0
        ? { password: this.decrypt(row) }
        : {}),
      ...(row.url !== undefined ? { url: row.url } : {}),
      ...(row.updatedAt !== undefined ? { updatedAt: row.updatedAt } : {}),
    };
  }

  private decrypt(row: StoredCredentialRow): string {
    const blob = row.secret;
    if (!blob || blob.length === 0) return '';
    if (!this.encryptionAvailable) {
      throw new Error(
        '系统凭据库不可用，无法解密凭据「' + row.key + '」。请重新填写密码后再试。',
      );
    }
    try {
      return safeStorage.decryptString(blob);
    } catch (error) {
      this.logger.error({ err: String(error), key: row.key }, 'credential decrypt failed');
      throw new Error(
        '无法解密凭据「' + row.key + '」，可能是系统账户或密钥已变更，请重新填写密码。',
      );
    }
  }
}

/**
 * Stand-in used when the desktop database could not be opened.
 *
 * Reads miss and writes fail loudly, so a flow that needs a password stops with
 * an actionable message instead of silently sending an empty one.
 */
export class UnavailableCredentialVault extends InMemoryCredentialStore {
  public constructor(private readonly reason: string) {
    super();
  }

  public override async set(_input: CredentialInput): Promise<CredentialRecord> {
    throw new Error('凭据存储不可用：' + this.reason);
  }
}
