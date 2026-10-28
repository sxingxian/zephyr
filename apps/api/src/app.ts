import { Hono } from 'hono';
import { fail, logError } from './http';
import { adminRoutes } from './routes/admin';
import { appAuthRoutes } from './routes/app-auth';
import { inviteRoutes } from './routes/invites';
import { meRoutes } from './routes/me';
import { publicRoutes } from './routes/public';
import type { HonoEnv } from './types';

const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST', 'PATCH', 'DELETE']);

export const app = new Hono<HonoEnv>();

// ---- Global middleware -------------------------------------------------------------------------
app.use('*', async (c, next) => {
  const requestId = crypto.randomUUID();
  c.set('requestId', requestId);
  if (!ALLOWED_METHODS.has(c.req.method)) {
    const res = c.json(fail('method_not_allowed'), 405, { Allow: 'GET, HEAD, POST, PATCH, DELETE' });
    applyHeaders(res.headers, c.req.method, requestId);
    return res;
  }
  await next();
  applyHeaders(c.res.headers, c.req.method, requestId);
});

function applyHeaders(h: Headers, method: string, requestId: string) {
  h.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('Referrer-Policy', 'no-referrer');
  h.set('Cross-Origin-Resource-Policy', 'same-origin');
  h.set('X-Request-Id', requestId);
  // Only explicitly cacheable GETs (public config) may be cached; anything with a cookie never is.
  if ((method !== 'GET' && method !== 'HEAD') || !h.has('Cache-Control') || h.has('Set-Cookie')) {
    h.set('Cache-Control', 'no-store');
  }
}

// ---- Routes ------------------------------------------------------------------------------------
// Members and the landing page (same origin on each host, via the site Workers' service bindings).
app.route('/api', publicRoutes);
app.route('/api/v1/auth', appAuthRoutes);
app.route('/api/v1/me', meRoutes);
app.route('/api/v1/invites', inviteRoutes);
// Admin console (zephyr.midnightpoetry.studio/admin, behind Cloudflare Access).
app.route('/admin/api', adminRoutes);

app.notFound((c) => c.json(fail('not_found'), 404));
app.onError((err, c) => {
  logError(c.get('requestId') ?? 'none', 'unhandled', err);
  return c.json(fail('server'), 500);
});
