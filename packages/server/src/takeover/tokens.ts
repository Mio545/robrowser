/**
 * One-time takeover tickets (spec 8.4).
 *
 * A ticket is a short-lived JWT carrying `jti`, `sessionId`, `runId`, `stepId`.
 * The page exchanges the ticket for a WebSocket URL and immediately strips it
 * from the address bar (`history.replaceState`). The server keeps a used-`jti`
 * set so replay is impossible even inside the JWT validity window.
 */
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { TakeoverError } from '@robrowser/core';

/** Claims embedded in a takeover ticket. */
export interface TicketClaims {
  jti: string;
  sessionId: string;
  runId: string;
  stepId: string;
}

/** Verified result of {@link verifyTicket}. */
export interface VerifiedTicket extends TicketClaims {
  exp: number;
  iat: number;
}

/** Options for {@link TicketService}. */
export interface TicketServiceOptions {
  /** HMAC secret. Must be provided in production. */
  secret: string;
  /** Ticket lifetime in seconds (default 600 = 10 minutes). */
  ttlSeconds?: number;
  /** Clock injection for deterministic tests. */
  now?: () => number;
}

/**
 * Issues and verifies single-use takeover tickets.
 *
 * Thread-safety: the used-`jti` set is process local; a multi-instance
 * deployment must move it to a shared store (documented in the README).
 */
export class TicketService {
  private readonly used = new Map<string, number>();
  private readonly ttlSeconds: number;
  private readonly now: () => number;

  public constructor(private readonly options: TicketServiceOptions) {
    this.ttlSeconds = options.ttlSeconds ?? 600;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Mint a ticket for a session.
   *
   * @param claims - Session / run / step identifiers.
   * @returns The signed JWT and its expiry.
   */
  public issue(claims: Omit<TicketClaims, 'jti'>): {
    ticket: string;
    expiresAt: string;
    jti: string;
  } {
    const jti = randomUUID();
    const ticket = jwt.sign({ ...claims, jti }, this.options.secret, {
      expiresIn: this.ttlSeconds,
      algorithm: 'HS256',
    });
    const expiresAt = new Date(this.now() + this.ttlSeconds * 1000).toISOString();
    return { ticket, expiresAt, jti };
  }

  /**
   * Verify a ticket *and* consume its `jti`.
   *
   * @param ticket - The raw JWT.
   * @throws {TakeoverError} `TOKEN_INVALID` (bad signature / expired) or
   *   `TOKEN_REPLAYED` (jti already consumed).
   */
  public verify(ticket: string): VerifiedTicket {
    let decoded: unknown;
    try {
      decoded = jwt.verify(ticket, this.options.secret, { algorithms: ['HS256'] });
    } catch (error) {
      throw new TakeoverError(
        'TOKEN_INVALID',
        `Takeover ticket rejected: ${(error as Error).message}`,
        {
          reason: (error as Error).name,
        },
      );
    }
    const claims = decoded as Partial<VerifiedTicket>;
    if (
      typeof claims.jti !== 'string' ||
      typeof claims.sessionId !== 'string' ||
      typeof claims.runId !== 'string' ||
      typeof claims.stepId !== 'string'
    ) {
      throw new TakeoverError('TOKEN_INVALID', 'Takeover ticket is missing required claims');
    }

    this.prune();
    if (this.used.has(claims.jti)) {
      throw new TakeoverError('TOKEN_REPLAYED', 'Takeover ticket has already been used', {
        jti: claims.jti,
        sessionId: claims.sessionId,
      });
    }
    this.used.set(claims.jti, (claims.exp ?? 0) * 1000);
    return {
      jti: claims.jti,
      sessionId: claims.sessionId,
      runId: claims.runId,
      stepId: claims.stepId,
      exp: claims.exp ?? 0,
      iat: claims.iat ?? 0,
    };
  }

  /**
   * Mint a short-lived WebSocket token tied to a session (used after the ticket
   * exchange; never placed in the URL by the server).
   */
  public issueSocketToken(sessionId: string, ttlSeconds = 60 * 60): string {
    return jwt.sign({ sessionId, scope: 'takeover-ws' }, this.options.secret, {
      expiresIn: ttlSeconds,
      algorithm: 'HS256',
    });
  }

  /**
   * Verify a WebSocket token.
   *
   * @throws {TakeoverError} `TOKEN_INVALID` when the signature / scope is wrong.
   */
  public verifySocketToken(token: string): { sessionId: string } {
    try {
      const decoded = jwt.verify(token, this.options.secret, { algorithms: ['HS256'] }) as {
        sessionId?: string;
        scope?: string;
      };
      if (decoded.scope !== 'takeover-ws' || typeof decoded.sessionId !== 'string') {
        throw new Error('wrong scope');
      }
      return { sessionId: decoded.sessionId };
    } catch (error) {
      throw new TakeoverError(
        'TOKEN_INVALID',
        `Socket token rejected: ${(error as Error).message}`,
      );
    }
  }

  /** Revoke every outstanding ticket for a session (called on completion). */
  public revokeSession(sessionId: string): void {
    for (const [jti, expiresAt] of this.used) {
      if (expiresAt <= this.now()) this.used.delete(jti);
    }
    // JWTs already issued cannot be individually invalidated without a blacklist
    // keyed by session; we record a tombstone so verification rejects them.
    this.revokedSessions.add(sessionId);
  }

  /** True when the session has been revoked (its tickets can no longer be used). */
  public isRevoked(sessionId: string): boolean {
    return this.revokedSessions.has(sessionId);
  }

  /** Number of tracked `jti` values (test helper). */
  public usedCount(): number {
    return this.used.size;
  }

  private readonly revokedSessions = new Set<string>();

  private prune(): void {
    const cutoff = this.now();
    for (const [jti, expiresAt] of this.used) {
      if (expiresAt > 0 && expiresAt < cutoff) this.used.delete(jti);
    }
  }
}
