/**
 * FlowModel validation + variable interpolation (spec 11: core).
 */
import { describe, expect, it } from 'vitest';
import { flowModelSchema, type FlowModel } from './schema.js';
import { assertValidFlow, collectSteps, validateFlow } from './validate.js';
import { interpolate, VariableStore, type VariableEnvironment } from '../vars/store.js';
import { InMemoryCredentialStore, type ResolvedCredential } from '../credentials/store.js';
import { isSecretDef, resolveVariableDef } from '../vars/resolvers.js';
import { VariableUndefinedError, ValidationError } from '../errors.js';

/** A minimal valid flow used as the base for the negative cases below. */
function baseFlow(): FlowModel {
  return {
    version: '1.0',
    id: 'demo',
    name: 'Demo',
    variables: {
      user: { type: 'const', value: 'alice' },
      token: { type: 'secret', key: 'DEMO_TOKEN', default: 's3cret' },
    },
    steps: [{ id: 'open', type: 'goto', url: 'file:///tmp/login.html' }],
    onError: { retry: 1, backoff: 'linear' },
  };
}

/** Narrow a stored record to the shape `VariableEnvironment` hands back. */
function resolveRecord(
  record: { username?: string; password?: string; url?: string } | undefined,
): ResolvedCredential | undefined {
  if (!record) return undefined;
  return {
    username: record.username ?? '',
    password: record.password ?? '',
    ...(record.url ? { url: record.url } : {}),
  };
}

describe('FlowModel schema', () => {
  it('accepts a well-formed flow', () => {
    const result = validateFlow(baseFlow());
    expect(result.ok).toBe(true);
    expect(result.flow?.steps).toHaveLength(1);
  });

  it('rejects an unknown version', () => {
    const invalid = { ...baseFlow(), version: '2.0' };
    expect(flowModelSchema.safeParse(invalid).success).toBe(false);
    expect(validateFlow(invalid).ok).toBe(false);
  });

  it('rejects empty step lists and unknown step keys', () => {
    expect(validateFlow({ ...baseFlow(), steps: [] }).ok).toBe(false);
    const extra = baseFlow();
    (extra.steps[0] as unknown as Record<string, unknown>).surprise = true;
    const result = validateFlow(extra);
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.code === 'unrecognized_keys')).toBe(true);
  });

  it('rejects duplicate step ids across nested branch/loop steps', () => {
    const flow = baseFlow();
    flow.steps = [
      {
        id: 'branch',
        type: 'branch',
        condition: { varEquals: { name: 'user', value: 'alice' } },
        then: [{ id: 'open', type: 'setVar', name: 'x', value: 1 }],
        else: [],
      },
      flow.steps[0]!,
    ];
    const result = validateFlow(flow);
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.code === 'custom_duplicate_step_id')).toBe(true);
  });

  it('keeps `unknown` fields required (setVar.value, const.value)', () => {
    const missingValue = baseFlow();
    missingValue.steps = [{ id: 'v', type: 'setVar', name: 'x' } as never];
    expect(validateFlow(missingValue).ok).toBe(false);
    const missingConst = baseFlow();
    missingConst.variables = { bad: { type: 'const' } as never };
    expect(validateFlow(missingConst).ok).toBe(false);
  });

  it('collects every nested step in document order', () => {
    const flow = baseFlow();
    flow.steps = [
      {
        id: 'loop',
        type: 'loop',
        items: [1, 2],
        as: 'item',
        steps: [{ id: 'inner', type: 'setVar', name: 'x', value: '{{item}}' }],
      },
      { id: 'end', type: 'screenshot', saveTo: 'end.png' },
    ];
    expect(collectSteps(flow.steps).map((step) => step.id)).toEqual(['loop', 'inner', 'end']);
  });

  it('assertValidFlow throws a typed ValidationError', () => {
    expect(() => assertValidFlow({ version: '1.0' })).toThrow(ValidationError);
  });
});

describe('VariableStore + interpolate', () => {
  const env: VariableEnvironment = {
    get: (key) => ({ DEMO_TOKEN: 'from-env' })[key],
  };

  it('resolves const / env / secret / input and honours precedence', async () => {
    const store = new VariableStore(env);
    await store.declare(
      {
        answer: { type: 'const', value: 42 },
        token: { type: 'secret', key: 'DEMO_TOKEN' },
        missing: { type: 'env', key: 'NOPE', default: 'fallback' },
        who: { type: 'input', label: 'Who', default: 'world' },
      },
      { who: 'operator' },
    );
    expect(store.get('answer')).toBe(42);
    expect(store.get('token')).toBe('from-env');
    expect(store.get('missing')).toBe('fallback');
    expect(store.get('who')).toBe('operator');
  });

  it('redacts secrets in snapshots', async () => {
    const store = new VariableStore(env);
    await store.declare({ token: { type: 'secret', key: 'DEMO_TOKEN' } });
    expect(store.snapshot({ redactSecrets: true }).token?.value).toBe('***');
    expect(store.snapshot().token?.value).toBe('from-env');
  });

  it('resolves a credential from the vault and redacts it everywhere', async () => {
    const vault = new InMemoryCredentialStore([
      { key: 'github', username: 'alice', password: 'p4ss', url: 'https://github.com/login' },
    ]);
    const credentialEnv: VariableEnvironment = {
      get: (key) => env.get(key),
      getCredential: (key) => vault.get(key).then((record) => resolveRecord(record)),
    };
    const store = new VariableStore(credentialEnv);
    await store.declare({
      login: { type: 'credential', key: 'github' },
      token: { type: 'secret', key: 'DEMO_TOKEN' },
    });

    expect(store.get('login.username')).toBe('alice');
    expect(store.get('login.password')).toBe('p4ss');
    // The password must never survive a snapshot / checkpoint / run summary.
    expect(store.snapshot({ redactSecrets: true }).login?.value).toBe('***');
    expect(store.snapshot({ redactSecrets: true }).token?.value).toBe('***');
    expect(store.snapshot().login?.value).toEqual({
      username: 'alice',
      password: 'p4ss',
      url: 'https://github.com/login',
    });
  });

  it('fails loudly when a credential is missing from the vault', async () => {
    const store = new VariableStore({ get: () => undefined, getCredential: () => undefined });
    await expect(
      store.declare({ login: { type: 'credential', key: 'nope' } }),
    ).rejects.toThrow(VariableUndefinedError);
  });

  it('treats credential as a secret declaration for UI / redaction purposes', () => {
    expect(isSecretDef({ type: 'credential', key: 'x' })).toBe(true);
    expect(isSecretDef({ type: 'secret', key: 'x' })).toBe(true);
    expect(isSecretDef({ type: 'env', key: 'x' })).toBe(false);
  });

  it('resolves a credential declaration through resolveVariableDef', async () => {
    const resolved = await resolveVariableDef(
      'login',
      { type: 'credential', key: 'github' },
      { get: () => undefined, getCredential: async () => ({ username: 'a', password: 'b' }) },
    );
    expect(resolved).toEqual({ username: 'a', password: 'b' });
  });

  it('interpolates recursively and preserves primitive types for whole strings', () => {
    const store = new VariableStore();
    store.set('count', 3);
    store.set('user', { name: 'alice', tags: ['a', 'b'] });
    const out = store.interpolate({
      message: 'hello {{user.name}} x{{count}}',
      exact: '{{count}}',
      list: ['{{user.tags[1]}}', 'plain'],
    });
    expect(out).toEqual({
      message: 'hello alice x3',
      exact: 3,
      list: ['b', 'plain'],
    });
  });

  it('throws a VariableUndefinedError naming the variable and location', () => {
    expect(() => interpolate({ url: 'http://x/{{missing}}/y' }, () => undefined)).toThrow(
      VariableUndefinedError,
    );
    try {
      interpolate({ url: 'http://x/{{missing}}/y' }, () => undefined);
    } catch (error) {
      expect((error as VariableUndefinedError).message).toContain('missing');
      expect((error as VariableUndefinedError).message).toContain('$.url');
    }
  });

  it('walks dotted / bracketed paths', () => {
    const store = new VariableStore();
    store.set('items', [{ id: 7 }, { id: 9 }]);
    expect(store.get('items[1].id')).toBe(9);
    expect(store.tryGet('items[5].id')).toBeUndefined();
  });
});
