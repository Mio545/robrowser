/**
 * Variable resolution: `const` / `env` / `secret` / `input` declarations plus
 * runtime values produced by steps and the hosting application (spec 5.4).
 */
import { VariableUndefinedError } from '../errors.js';
import type { VariableDef } from '../flow/schema.js';

/** Runtime origin of a variable, used for redaction and UI grouping. */
export type VarScope = 'const' | 'env' | 'secret' | 'input' | 'runtime';

/** A stored variable together with its origin. */
export interface VarEntry {
  name: string;
  value: unknown;
  scope: VarScope;
}

/** Environment access surface (injectable for tests). */
export interface VariableEnvironment {
  /** Read an environment variable; returns undefined when unset. */
  get(key: string): string | undefined;
  /** Supplies `input` variables; the host may prompt the user. */
  requestInput?(
    name: string,
    def: Extract<VariableDef, { type: 'input' }>,
  ): Promise<string | undefined>;
}

/** Default environment backed by `process.env`. */
export const processEnvironment: VariableEnvironment = {
  get: (key) => process.env[key],
  requestInput: undefined,
};

const INTERPOLATION = /\{\{\s*([A-Za-z0-9_.\-[\]$]+)\s*\}\}/g;

/**
 * Storage for flow variables with `{{name}}` interpolation.
 *
 * Precedence when resolving a name: explicit runtime `set` > declaration.
 * Secret values are never emitted through `snapshot({ redactSecrets: true })`.
 */
export class VariableStore {
  private readonly values = new Map<string, VarEntry>();
  private env: VariableEnvironment;

  public constructor(env: VariableEnvironment = processEnvironment) {
    this.env = env;
  }

  /** Replace the environment implementation (used by tests / hosts). */
  public setEnvironment(env: VariableEnvironment): void {
    this.env = env;
  }

  /**
   * Declare variables from a flow's `variables` map.
   *
   * @param defs - Variable definitions from the FlowModel.
   * @param overrides - Values supplied by the user (`--var k=v` / UI inputs).
   */
  public async declare(
    defs: Record<string, VariableDef> | undefined,
    overrides: Record<string, unknown> = {},
  ): Promise<void> {
    if (!defs) {
      for (const [name, value] of Object.entries(overrides)) {
        this.values.set(name, { name, value, scope: 'input' });
      }
      return;
    }
    for (const [name, def] of Object.entries(defs)) {
      if (Object.prototype.hasOwnProperty.call(overrides, name)) {
        this.values.set(name, { name, value: overrides[name], scope: scopeFor(def) });
        continue;
      }
      this.values.set(name, {
        name,
        value: await this.resolveDef(name, def),
        scope: scopeFor(def),
      });
    }
    // Overrides for names not declared in the flow are still useful.
    for (const [name, value] of Object.entries(overrides)) {
      if (!this.values.has(name)) this.values.set(name, { name, value, scope: 'input' });
    }
  }

  /** Resolve a single declaration to a concrete value. */
  private async resolveDef(name: string, def: VariableDef): Promise<unknown> {
    switch (def.type) {
      case 'const':
        return def.value;
      case 'env': {
        const raw = this.env.get(def.key);
        if (raw !== undefined) return raw;
        if (def.default !== undefined) return def.default;
        throw new VariableUndefinedError(name, `variables.${name} (env ${def.key})`);
      }
      case 'secret': {
        const raw = this.env.get(def.key);
        if (raw !== undefined) return raw;
        if (def.default !== undefined) return def.default;
        throw new VariableUndefinedError(name, `variables.${name} (secret ${def.key})`);
      }
      case 'input': {
        const supplied = await this.env.requestInput?.(name, def);
        if (supplied !== undefined) return supplied;
        if (def.default !== undefined) return def.default;
        return '';
      }
      default: {
        const exhaustive: never = def;
        throw new VariableUndefinedError(name, String(exhaustive));
      }
    }
  }

  /** Set (or overwrite) a runtime variable produced by a step. */
  public set(name: string, value: unknown, scope: VarScope = 'runtime'): void {
    this.values.set(name, { name, value, scope });
  }

  /** True when the name is defined. */
  public has(name: string): boolean {
    return this.values.has(name);
  }

  /**
   * Read a variable by name. Dotted / bracketed paths traverse nested objects,
   * e.g. `user.name` or `items[0].id`.
   *
   * @throws {VariableUndefinedError} When the name cannot be resolved.
   */
  public get(name: string): unknown {
    if (this.values.has(name)) return this.values.get(name)!.value;

    const path = name.split(/[.[\]]+/).filter((segment) => segment.length > 0);
    const [head, ...rest] = path;
    if (head === undefined) throw new VariableUndefinedError(name, '<root>');
    const entry = this.values.get(head);
    if (!entry) throw new VariableUndefinedError(name, 'variables');
    let current: unknown = entry.value;
    for (const segment of rest) {
      if (current === null || current === undefined) {
        throw new VariableUndefinedError(name, `variables.${name}`);
      }
      if (Array.isArray(current)) {
        const index = Number(segment);
        if (!Number.isInteger(index) || index < 0 || index >= current.length) {
          throw new VariableUndefinedError(name, `variables.${name}`);
        }
        current = current[index];
      } else if (typeof current === 'object') {
        const record = current as Record<string, unknown>;
        if (!Object.prototype.hasOwnProperty.call(record, segment)) {
          throw new VariableUndefinedError(name, `variables.${name}`);
        }
        current = record[segment];
      } else {
        throw new VariableUndefinedError(name, `variables.${name}`);
      }
    }
    return current;
  }

  /** Read without throwing; returns undefined when unresolvable. */
  public tryGet(name: string): unknown {
    try {
      return this.get(name);
    } catch {
      return undefined;
    }
  }

  /**
   * Snapshot all variables.
   *
   * @param options.redactSecrets - Replace secret values with `***`.
   */
  public snapshot(options: { redactSecrets?: boolean } = {}): Record<string, VarEntry> {
    const out: Record<string, VarEntry> = {};
    for (const [name, entry] of this.values) {
      const redact = options.redactSecrets && entry.scope === 'secret';
      out[name] = { ...entry, value: redact ? '***' : entry.value };
    }
    return out;
  }

  /** Remove every variable. */
  public clear(): void {
    this.values.clear();
  }

  /**
   * Recursively interpolate `{{name}}` occurrences inside strings / arrays /
   * objects.
   *
   * @param input - Value to interpolate.
   * @returns A new value; the input is never mutated.
   * @throws {VariableUndefinedError} When a referenced variable is missing.
   */
  public interpolate<T>(input: T): T {
    return interpolate(input, this) as T;
  }
}

function scopeFor(def: VariableDef): VarScope {
  return def.type;
}

/**
 * Free-function form of {@link VariableStore.interpolate}; reusable by exporters
 * and the desktop UI without constructing a store.
 *
 * @param input - Value to interpolate.
 * @param lookup - Resolver accepting a variable name and its textual location.
 */
export function interpolate<T>(
  input: T,
  lookup: { get(name: string): unknown } | ((name: string) => unknown),
): T {
  const resolve = typeof lookup === 'function' ? lookup : (name: string) => lookup.get(name);

  const walk = (value: unknown, location: string): unknown => {
    if (typeof value === 'string') {
      if (!value.includes('{{')) return value;
      // Fully-templated strings keep their original primitive type.
      const whole = new RegExp(`^${INTERPOLATION.source}$`).exec(value.trim());
      if (whole && whole[1] !== undefined) {
        return resolveOrThrow(resolve, whole[1], location);
      }
      return value.replace(INTERPOLATION, (match, name: string) => {
        const resolved = resolveOrThrow(resolve, name, location);
        return stringifyInterpolated(resolved);
      });
    }
    if (Array.isArray(value))
      return value.map((item, index) => walk(item, `${location}[${index}]`));
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        out[key] = walk(item, `${location}.${key}`);
      }
      return out;
    }
    return value;
  };

  return walk(input, '$') as T;
}

function resolveOrThrow(
  resolve: (name: string) => unknown,
  name: string,
  location: string,
): unknown {
  const value = resolve(name);
  if (value === undefined) throw new VariableUndefinedError(name, location);
  return value;
}

function stringifyInterpolated(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
