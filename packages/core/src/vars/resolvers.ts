/**
 * Variable resolvers for the five declaration kinds plus step outputs.
 *
 * These are thin, stateless helpers on top of {@link VariableStore}; they exist
 * so that the desktop UI and exporters can resolve the same way at author time.
 */
import type { VariableDef } from '../flow/schema.js';
import { interpolate, VariableStore, type VariableEnvironment } from './store.js';

/**
 * Which declaration kinds must never be echoed back.
 *
 * `credential` carries a password, so it is redacted exactly like `secret`.
 */
export function isSecretDef(def: VariableDef): boolean {
  return def.type === 'secret' || def.type === 'credential';
}

/**
 * Resolve a declaration without mutating any store.
 *
 * @param name - Variable name (used in error messages).
 * @param def - The declaration.
 * @param env - Environment accessor.
 */
export async function resolveVariableDef(
  name: string,
  def: VariableDef,
  env: VariableEnvironment,
): Promise<unknown> {
  switch (def.type) {
    case 'const':
      return def.value;
    case 'env':
      return env.get(def.key) ?? def.default;
    case 'secret':
      return env.get(def.key) ?? def.default;
    case 'credential':
      return env.getCredential?.(def.key);
    case 'input': {
      const supplied = await env.requestInput?.(name, def);
      return supplied ?? def.default ?? '';
    }
    default: {
      const exhaustive: never = def;
      return exhaustive;
    }
  }
}

/** Re-export so callers can `import { interpolate } from '../vars/resolvers.js'`. */
export { interpolate };

/**
 * Build a store from a declaration map plus overrides, using an explicit
 * environment. Convenience for tests, CLI and the Electron host.
 */
export async function buildVariableStore(
  defs: Record<string, VariableDef> | undefined,
  overrides: Record<string, unknown>,
  env: VariableEnvironment,
): Promise<VariableStore> {
  const store = new VariableStore(env);
  await store.declare(defs, overrides);
  return store;
}
