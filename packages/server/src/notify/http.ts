/**
 * Shared JSON POST transport for the HTTP-based notification channels.
 *
 * `fetch` collapses every transport problem (DNS, TLS, refused connection,
 * timeout) into a bare 'fetch failed'. An operator paged at 03:00 needs the real
 * reason, so the cause chain is unwrapped into the thrown message - the channels
 * and the notifier log surface it as-is.
 */
import type { FetchLike } from './build.js';

/** Options for {@link postJson}. */
export interface PostJsonOptions {
  /** Extra request headers (auth tokens, ...). */
  headers?: Record<string, string>;
  /** Delivery timeout in milliseconds. */
  timeoutMs?: number;
  /** Channel name used in error messages ('feishu', 'dingtalk', 'webhook', 'email'). */
  channel: string;
}

/** A transport-level result; HTTP status is reported, not thrown. */
export interface JsonResponse {
  ok: boolean;
  status: number;
  /** Parsed body, or 'undefined' when the body was empty / not JSON. */
  payload: unknown;
}

/** Flatten an error cause chain into one readable sentence. */
export function describeError(error: unknown): string {
  const parts: string[] = [];
  let cursor: unknown = error;
  for (let depth = 0; depth < 5 && cursor instanceof Error; depth += 1) {
    const code = (cursor as { code?: unknown }).code;
    parts.push(typeof code === 'string' ? `${cursor.message} (${code})` : cursor.message);
    cursor = cursor.cause;
  }
  if (parts.length === 0) parts.push(String(error));
  return [...new Set(parts)].join(' <- ');
}

/**
 * POST a JSON body.
 *
 * @param fetchImpl - Fetch implementation (injectable in tests).
 * @param url - Absolute target URL.
 * @param body - Serialised as the JSON request body.
 * @param options - Headers, timeout and the channel name used in errors.
 * @returns Status plus the parsed body (never throws for a non-2xx status).
 * @throws {Error} When the request never completed (transport failure).
 */
export async function postJson(
  fetchImpl: FetchLike,
  url: string,
  body: unknown,
  options: PostJsonOptions,
): Promise<JsonResponse> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
  } catch (error) {
    throw new Error(`${options.channel} request failed: ${describeError(error)}`);
  }
  const payload = await response.json().catch(() => undefined);
  return { ok: response.ok, status: response.status, payload };
}
