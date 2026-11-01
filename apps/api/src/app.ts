import { Hono } from 'hono';
import { rejectDuplicateCookies } from './auth/session';
import { fail, logError } from './http';
import { adminRoutes } from './routes/admin';
import { aiRoutes } from './routes/ai';
import { albumRoutes } from './routes/albums';
import { appAuthRoutes } from './routes/app-auth';
import { brandingRoutes } from './routes/branding';
import { galleryRoutes } from './routes/galleries';
import { guestRoutes } from './routes/guest';
import { inviteRoutes } from './routes/invites';
import { meRoutes } from './routes/me';
import { photoRoutes } from './routes/photos';
import { publicRoutes } from './routes/public';
import { recipeRoutes } from './routes/recipes';
import { trashRoutes } from './routes/trash';
import { uploadRoutes } from './routes/uploads';
import type { HonoEnv } from './types';

const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);

export const app = new Hono<HonoEnv>();

// ---- Global middleware -------------------------------------------------------------------------
app.use('*', async (c, next) => {
  const requestId = crypto.randomUUID();
  c.set('requestId', requestId);
  if (!ALLOWED_METHODS.has(c.req.method)) {
    const res = c.json(fail('method_not_allowed'), 405, { Allow: 'GET, HEAD, POST, PUT, PATCH, DELETE' });
    applyHeaders(res.headers, c.req.method, requestId);
    return res;
  }
  await next();
  applyHeaders(c.res.headers, c.req.method, requestId);
});

function applyHeaders(h: Headers, method: string, requestId: string) {
  // Media responses set their own (stricter) sandbox policy; everything else gets the API default.
  if (!h.has('Content-Security-Policy')) {
    h.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  }
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
// A session cookie name sent twice means one copy was planted: refuse before anything reads them.
app.use('/api/*', rejectDuplicateCookies('app'));
app.use('/admin/api/*', rejectDuplicateCookies('admin'));
// Members and the landing page (same origin on each host, via the site Workers' service bindings).
app.route('/api', publicRoutes);
app.route('/api/v1/auth', appAuthRoutes);
// Before /api/v1/me, so its own guards answer these paths.
app.route('/api/v1/me/branding', brandingRoutes);
app.route('/api/v1/me', meRoutes);
app.route('/api/v1/invites', inviteRoutes);
app.route('/api/v1/uploads', uploadRoutes);
app.route('/api/v1/photos', photoRoutes);
app.route('/api/v1/albums', albumRoutes);
app.route('/api/v1/trash', trashRoutes);
app.route('/api/v1/recipes', recipeRoutes);
// Zephyr AI (phase 6).
app.route('/api/v1/ai', aiRoutes);
// Sharing (phase 5): members' galleries, and guests (the link token is the capability).
app.route('/api/v1/galleries', galleryRoutes);
app.route('/api/v1/g', guestRoutes);
// Admin console (zephyr.midnightpoetry.studio/admin, behind Cloudflare Access).
app.route('/admin/api', adminRoutes);

app.notFound((c) => c.json(fail('not_found'), 404));
app.onError((err, c) => {
  logError(c.get('requestId') ?? 'none', 'unhandled', err);
  return c.json(fail('server'), 500);
});
