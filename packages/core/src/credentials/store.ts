/**
 * Credential storage abstraction (web login vault).
 *
 * `core` only defines the contract: the desktop host backs it with the OS
 * keychain (Electron `safeStorage`), the headless server with an AES-GCM
 * encrypted file. `{ type: "credential" }` variable declarations resolve
 * through this interface, which is what keeps passwords out of the FlowModel
 * JSON, out of run summaries and out of exported scripts.
 */
import { ValidationError } from "../errors.js";

/** A stored web-login credential. */
export interface CredentialRecord {
  /** Stable identifier referenced by `{ type: "credential", key }`. */
  key: string;
  /** Login name / e-mail address. */
  username?: string;
  /** Login password. Never logged, never written to a flow. */
  password?: string;
  /** Optional site the credential belongs to (informational). */
  url?: string;
  /** ISO timestamp of the last write, filled in by the host. */
  updatedAt?: string;
}

/** Redacted view of a credential, safe for lists and renderers. */
export interface CredentialSummary {
  key: string;
  username?: string;
  url?: string;
  updatedAt?: string;
}

/**
 * Environment variables an *exported* script reads a credential from.
 *
 * A generated Playwright / raw-CDP script has no access to the host vault, so
 * the exporter emits the same `process.env` lookups and this helper defines the
 * naming convention shared by the exporter and the importer.
 */
export function credentialEnvKeys(key: string): { username: string; password: string } {
  const suffix = key.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return {
    username: `ROBO_CRED_${suffix}_USERNAME`,
    password: `ROBO_CRED_${suffix}_PASSWORD`,
  };
}

/** Values accepted when creating / updating a credential. */
export interface CredentialInput {
  key: string;
  username?: string;
  password?: string;
  url?: string;
}

/**
 * Host-provided credential backend.
 *
 * Every method is async because a real backend may be a keychain, a child
 * process or an encrypted file.
 */
export interface CredentialStore {
  /** Read one credential (with secrets). Returns undefined when unset. */
  get(key: string): Promise<CredentialRecord | undefined>;
  /** Insert or replace a credential. */
  set(input: CredentialInput): Promise<CredentialRecord>;
  /** Remove a credential. Returns true when something was deleted. */
  delete(key: string): Promise<boolean>;
  /** List redacted metadata, never the passwords. */
  list(): Promise<CredentialSummary[]>;
}

/** What `{ type: "credential" }` resolves to at run time. */
export interface ResolvedCredential {
  username: string;
  password: string;
  url?: string;
}

/** Normalise and validate a credential write (shared by every backend). */
export function normalizeCredential(input: CredentialInput): CredentialRecord {
  const key = typeof input.key === "string" ? input.key.trim() : "";
  if (key.length === 0) throw new ValidationError("凭据名不能为空");
  const username = trimToUndefined(input.username);
  const password = trimToUndefined(input.password);
  const url = trimToUndefined(input.url);
  if (username === undefined && password === undefined) {
    throw new ValidationError(`凭据「${key}」至少要填写用户名或密码`);
  }
  return {
    key,
    ...(username !== undefined ? { username } : {}),
    ...(password !== undefined ? { password } : {}),
    ...(url !== undefined ? { url } : {}),
  };
}

/** Project a record down to its redacted summary. */
export function summarizeCredential(record: CredentialRecord): CredentialSummary {
  return {
    key: record.key,
    ...(record.username !== undefined ? { username: record.username } : {}),
    ...(record.url !== undefined ? { url: record.url } : {}),
    ...(record.updatedAt !== undefined ? { updatedAt: record.updatedAt } : {}),
  };
}

function trimToUndefined(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Process-memory credential store.
 *
 * Used by tests, by hosts that have no persistent vault, and as the "nothing
 * configured" default: reads simply miss and the run fails with a clear
 * `VARIABLE_UNDEFINED` message instead of silently sending an empty password.
 */
export class InMemoryCredentialStore implements CredentialStore {
  private readonly records = new Map<string, CredentialRecord>();

  public constructor(initial: readonly CredentialInput[] = []) {
    for (const input of initial) {
      const record = normalizeCredential(input);
      this.records.set(record.key, { ...record, updatedAt: new Date().toISOString() });
    }
  }

  public get(key: string): Promise<CredentialRecord | undefined> {
    const stored = this.records.get(key);
    return Promise.resolve(stored ? { ...stored } : undefined);
  }

  public set(input: CredentialInput): Promise<CredentialRecord> {
    const record = normalizeCredential(input);
    const next: CredentialRecord = { ...record, updatedAt: new Date().toISOString() };
    this.records.set(next.key, next);
    return Promise.resolve({ ...next });
  }

  public delete(key: string): Promise<boolean> {
    return Promise.resolve(this.records.delete(key));
  }

  public list(): Promise<CredentialSummary[]> {
    return Promise.resolve(
      [...this.records.values()]
        .map((record) => summarizeCredential(record))
        .sort((a, b) => a.key.localeCompare(b.key)),
    );
  }
}
