import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { Account, Db } from './db.ts';
import { newId } from './manager.ts';

export type Principal = { type: 'admin' } | { type: 'account'; account: Account } | { type: 'anonymous' };

export function newToken(): string {
  return randomBytes(24).toString('base64url');
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function tokenFromRequest(req: Request): string | null {
  const h = req.headers.authorization;
  if (h?.startsWith('Bearer ')) return h.slice(7).trim();
  const q = req.query?.token;
  return typeof q === 'string' && q ? q : null;
}

export class Auth {
  private jwks = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

  constructor(
    private db: Db,
    private adminToken: string,
    private googleClientId: string | null,
  ) {}

  resolve(token: string | null): Principal {
    if (!token) return { type: 'anonymous' };
    if (safeEqual(token, this.adminToken)) return { type: 'admin' };
    const account = this.db.accountByToken(token);
    return account ? { type: 'account', account } : { type: 'anonymous' };
  }

  createGuest(name: string): { account: Account; token: string } {
    const token = newToken();
    const account = this.db.createAccount({
      id: newId('h'),
      kind: 'human',
      name: name.trim().slice(0, 32) || 'Guest',
      email: null,
      provider: 'human',
      model: null,
      verified: false,
      client: 'web',
      token,
    });
    return { account, token };
  }

  /** Create an AI agent identity. `verified` means the admin/runner vouches for the model. */
  createAgent(input: { name: string; provider?: string | null; model?: string | null; verified?: boolean }): { account: Account; token: string } {
    const token = newToken();
    const account = this.db.createAccount({
      id: newId('a'),
      kind: 'ai',
      name: input.name.trim().slice(0, 32) || 'Agent',
      email: null,
      provider: input.provider ?? null,
      model: input.model ?? null,
      verified: input.verified ?? true,
      client: null,
      token,
    });
    return { account, token };
  }

  /** Verify a Google Identity Services credential (ID token) and return the matching account. */
  async google(credential: string): Promise<{ account: Account; token: string }> {
    if (!this.googleClientId) throw new Error('Google login is not configured on this server.');
    const { payload } = await jwtVerify(credential, this.jwks, {
      audience: this.googleClientId,
      issuer: ['https://accounts.google.com', 'accounts.google.com'],
    });
    const email = String(payload.email ?? '');
    if (!email || payload.email_verified === false) throw new Error('Google account has no verified email.');
    const existing = this.db.accountByEmail(email);
    if (existing) return { account: existing, token: existing.token };
    const token = newToken();
    const account = this.db.createAccount({
      id: newId('h'),
      kind: 'human',
      name: String(payload.given_name ?? payload.name ?? email.split('@')[0]).slice(0, 32),
      email,
      provider: 'human',
      model: null,
      verified: true,
      client: 'google',
      token,
    });
    return { account, token };
  }
}
