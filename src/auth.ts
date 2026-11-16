import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import type { Context } from 'hono';
import { config } from './config.ts';
import { db } from './db/client.ts';
import * as schema from './db/schema.ts';

const socialProviders: Record<string, { clientId: string; clientSecret: string }> = {};
if (config.github.clientId) socialProviders.github = config.github;
if (config.google.clientId) socialProviders.google = config.google;

export const providers = Object.keys(socialProviders) as ('github' | 'google')[];

export const auth = betterAuth({
  baseURL: config.publicUrl,
  basePath: '/auth',
  secret: config.secret,
  database: drizzleAdapter(db, {
    provider: 'pg',
    usePlural: true,
    schema: { users: schema.users, sessions: schema.sessions, accounts: schema.accounts, verifications: schema.verifications },
  }),
  socialProviders,
  emailAndPassword: { enabled: config.devLogin },
  telemetry: { enabled: false },
});

export interface Owner {
  id: string;
  name: string;
}

export async function currentOwner(c: Context): Promise<Owner | null> {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  return session ? { id: session.user.id, name: session.user.name } : null;
}

/** Turns a Better Auth API response into a redirect that keeps its cookies. */
export function redirectWithCookies(from: Response, location: string): Response {
  const headers = new Headers({ location });
  for (const cookie of from.headers.getSetCookie()) headers.append('set-cookie', cookie);
  return new Response(null, { status: 302, headers });
}

export async function startSocialSignIn(c: Context, provider: 'github' | 'google'): Promise<Response> {
  const res = await auth.api.signInSocial({
    body: { provider, callbackURL: '/' },
    headers: c.req.raw.headers,
    asResponse: true,
  });
  const { url } = (await res.json()) as { url: string };
  return redirectWithCookies(res, url);
}

const DEV_USER = { email: 'dev@agcontextlink.local', password: 'dev-login-only', name: 'Dev' };

export async function devSignIn(c: Context): Promise<Response> {
  const headers = c.req.raw.headers;
  let res = await auth.api.signInEmail({ body: DEV_USER, headers, asResponse: true });
  if (!res.ok) res = await auth.api.signUpEmail({ body: DEV_USER, headers, asResponse: true });
  return redirectWithCookies(res, '/');
}

export async function signOut(c: Context): Promise<Response> {
  const res = await auth.api.signOut({ headers: c.req.raw.headers, asResponse: true });
  return redirectWithCookies(res, '/');
}
