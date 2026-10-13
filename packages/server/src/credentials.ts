/**
 * Server-side web-login vault: an AES-256-GCM encrypted JSON file.
 *
 * The headless server has no OS keychain, so the password is encrypted with a
 * key taken from `ROBO_CREDENTIALS_KEY` (falling back to the `SECRET` used for
 * takeover tickets). The file only ever holds ciphertext: a leak of
 * `credentials.json` without the key reveals nothing.
 *
 * When no key material is configured at all, saving a *password* is refused —
 * exactly like the desktop refuses when the keychain is unavailable — so a
 * deployment cannot silently downgrade to plaintext.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Logger } from 'pino';
import {
  InMemoryCredentialStore,
  normalizeCredential,
  summarizeCredential,
  type CredentialInput,
  type CredentialRecord,
  type CredentialStore,
  type CredentialSummary,
} from '@robrowser/core';

/** On-disk shape of the vault file. */
interface VaultFile {
  version: 1;
  /** key -> encrypted record. */
  entries: Record<string, StoredEntry>;
}

/** One encrypted credential as persisted. */
interface StoredEntry {
  username?: string;
  url?: string;
  updatedAt: string;
  /** Base64 AES-256-GCM payload; absent for username-only credentials. */
  ciphertext?: string;
  iv?: string;
  tag?: string;
}

/** Fixed salt: the key is already a high-entropy secret from the environment. */
const SALT = 'robrowser-credential-vault-v1';

/** Options for {@link FileCredentialStore}. */
export interface FileCredentialStoreOptions {
  /** Absolute path of the JSON vault. */
  file: string;
  /** Key material; when empty, passwords cannot be stored. */
  key?: string;
  logger: Logger;
}

/**
 * Resolve the vault file and key from validated server config.
 *
 * Shared by the CLI, the workers and the credential subcommands so every entry
 * point reads and writes the *same* file. The key falls back to , so a
 * deployment that already sets it gets encrypted password storage for free.
 */
export function resolveCredentialVault(config: {
  ROBO_CREDENTIALS_FILE: string;
  ROBO_CREDENTIALS_KEY?: string | undefined;
  SECRET: string;
  RUN_DIR: string;
}): { file: string; key: string } {
  return {
    file: config.ROBO_CREDENTIALS_FILE.trim() || join(config.RUN_DIR, 'credentials.json'),
    key: config.ROBO_CREDENTIALS_KEY ?? config.SECRET,
  };
}

/**
 * AES-256-GCM credential store backed by a JSON file.
 *
 * Writes are serialised through a promise chain and land atomically via a
 * temporary file + rename, so a crash cannot leave a half-written vault.
 */
export class FileCredentialStore implements CredentialStore {
  private readonly file: string;
  private readonly key: Buffer | undefined;
  private readonly logger: Logger;
  private cache: VaultFile | undefined;
  /** Serialises read-modify-write cycles. */
  private chain: Promise<unknown> = Promise.resolve();

  public constructor(options: FileCredentialStoreOptions) {
    this.file = options.file;
    this.logger = options.logger;
    const material = options.key?.trim();
    this.key =
      material && material.length > 0 ? scryptSync(material, SALT, 32) : undefined;
  }

  /** True when a password can actually be encrypted. */
  public get encryptionAvailable(): boolean {
    return this.key !== undefined;
  }

  public async get(key: string): Promise<CredentialRecord | undefined> {
    const vault = await this.load();
    const entry = vault.entries[key];
    if (!entry) return undefined;
    return this.materialize(key, entry);
  }

  public set(input: CredentialInput): Promise<CredentialRecord> {
    return this.mutate(async (vault) => {
      const record = normalizeCredential(input);
      const previous = vault.entries[record.key];
      const entry: StoredEntry = {
        ...(record.username !== undefined ? { username: record.username } : {}),
        ...(record.url !== undefined ? { url: record.url } : {}),
        updatedAt: new Date().toISOString(),
      };

      if (record.password === undefined) {
        // Blank password = keep what is already stored.
        if (previous?.ciphertext) {
          entry.ciphertext = previous.ciphertext;
          entry.iv = previous.iv;
          entry.tag = previous.tag;
        }
      } else {
        if (!this.key) {
          throw new Error(
            '未配置 ROBO_CREDENTIALS_KEY（或 SECRET），服务端无法加密保存密码；' +
              '请设置密钥，或只保存用户名。',
          );
        }
        const sealed = this.seal(record.password);
        entry.ciphertext = sealed.ciphertext;
        entry.iv = sealed.iv;
        entry.tag = sealed.tag;
      }

      vault.entries[record.key] = entry;
      return { ...record, updatedAt: entry.updatedAt };
    });
  }

  public delete(key: string): Promise<boolean> {
    return this.mutate(async (vault) => {
      if (!(key in vault.entries)) return false;
      delete vault.entries[key];
      return true;
    });
  }

  public async list(): Promise<CredentialSummary[]> {
    const vault = await this.load();
    return Object.entries(vault.entries)
      .map(([key, entry]) =>
        summarizeCredential({
          key,
          ...(entry.username !== undefined ? { username: entry.username } : {}),
          ...(entry.url !== undefined ? { url: entry.url } : {}),
          updatedAt: entry.updatedAt,
        }),
      )
      .sort((a, b) => a.key.localeCompare(b.key));
  }

  /** Decrypt a stored entry into the shape the variable store consumes. */
  private materialize(key: string, entry: StoredEntry): CredentialRecord {
    const base: CredentialRecord = {
      key,
      ...(entry.username !== undefined ? { username: entry.username } : {}),
      ...(entry.url !== undefined ? { url: entry.url } : {}),
      updatedAt: entry.updatedAt,
    };
    if (!entry.ciphertext || !entry.iv || !entry.tag) return base;
    return { ...base, password: this.open(entry, key) };
  }

  /** AES-256-GCM encrypt; the tag is stored alongside the ciphertext. */
  private seal(plaintext: string): { ciphertext: string; iv: string; tag: string } {
    const key = this.key!;
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return {
      ciphertext: encrypted.toString('base64'),
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
    };
  }

  /** Decrypt, converting any failure into an actionable message. */
  private open(entry: StoredEntry, key: string): string {
    if (!this.key) {
      throw new Error(
        '无法解密凭据「' + key + '」：服务端缺少 ROBO_CREDENTIALS_KEY，请配置后重试。',
      );
    }
    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.key,
        Buffer.from(entry.iv!, 'base64'),
      );
      decipher.setAuthTag(Buffer.from(entry.tag!, 'base64'));
      return Buffer.concat([
        decipher.update(Buffer.from(entry.ciphertext!, 'base64')),
        decipher.final(),
      ]).toString('utf8');
    } catch (error) {
      this.logger.error({ err: String(error), key }, 'credential decrypt failed');
      throw new Error(
        '无法解密凭据「' + key + '」：密钥可能已变更，请重新保存密码。',
      );
    }
  }

  /** Read the vault once, tolerating a missing or corrupt file. */
  private async load(): Promise<VaultFile> {
    if (this.cache) return this.cache;
    try {
      const raw = await readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw) as VaultFile;
      this.cache = { version: 1, entries: parsed.entries ?? {} };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger.warn({ err: String(error), file: this.file }, 'credential vault unreadable');
      }
      this.cache = { version: 1, entries: {} };
    }
    return this.cache;
  }

  /** Run a read-modify-write cycle under the serialisation chain. */
  private mutate<T>(fn: (vault: VaultFile) => Promise<T>): Promise<T> {
    const next = this.chain.then(async () => {
      const vault = await this.load();
      const result = await fn(vault);
      await this.persist(vault);
      return result;
    });
    // Keep the chain alive even when a caller rejects, otherwise one failed
    // write would poison every later mutation.
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** Atomically replace the vault file. */
  private async persist(vault: VaultFile): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    await writeFile(temporary, JSON.stringify(vault, null, 2), 'utf8');
    await rename(temporary, this.file);
  }
}

/** Vault that refuses writes because no path/key was configured. */
export class DisabledCredentialStore extends InMemoryCredentialStore {
  public constructor(private readonly reason: string) {
    super();
  }

  public override async set(_input: CredentialInput): Promise<CredentialRecord> {
    throw new Error(this.reason);
  }
}
