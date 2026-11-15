/**
 * Read-only mode (phase 8, docs/phase-8.md › Read-only mode). While it's on (Admin › Settings, or by itself when the
 * photo store stops answering), every library write answers 503 `read_only_mode`, except the ones that only reduce
 * exposure or finish work already started:
 *
 *   - finishing an upload that already started (parts, variants, complete, abort); new uploads are refused;
 *   - Trash: moving to Trash, restoring, deleting forever and emptying Trash;
 *   - galleries: ending one, replacing its link, setting a new passcode, and removing photos from it;
 *   - Zephyr AI: cancelling or pausing a job, and "Turn off and delete" for face data;
 *   - branding: removing an image.
 *
 * Everything else under the library prefixes (edits of any kind, renames, favourites, albums, recipes, people,
 * AI jobs and signals, gallery settings, renders and new photos in a gallery, branding changes) is refused here,
 * before the session is even read, so a route added later starts closed. Two allowed routes look at their body
 * and refuse the content-adding part themselves (`photos/bulk` favourites and albums; gallery `photos` additions).
 * Account-level routes (sign-in, /me, billing, team membership) aren't library content and stay open.
 */
import type { MiddlewareHandler } from 'hono';
import { isReadOnly } from '../admin/app-status';
import { fail } from '../http';
import type { HonoEnv } from '../types';

const GATED = [
  '/api/v1/uploads',
  '/api/v1/photos',
  '/api/v1/albums',
  '/api/v1/trash',
  '/api/v1/recipes',
  '/api/v1/ai',
  '/api/v1/galleries',
  '/api/v1/me/branding',
];

const ID = '[^/]+';
/** Writes that stay open in read-only mode: [method, path pattern]. */
const ALLOWED: [string, RegExp][] = [
  ['DELETE', new RegExp(`^/api/v1/uploads/${ID}$`)],
  ['PUT', new RegExp(`^/api/v1/uploads/${ID}/parts/${ID}$`)],
  ['PUT', new RegExp(`^/api/v1/uploads/${ID}/variants/${ID}$`)],
  ['POST', new RegExp(`^/api/v1/uploads/${ID}/complete$`)],
  ['POST', /^\/api\/v1\/photos\/bulk$/], // the route refuses everything but trash/restore/delete forever
  ['POST', /^\/api\/v1\/trash\/empty$/],
  ['DELETE', new RegExp(`^/api/v1/ai/jobs/${ID}$`)],
  ['POST', new RegExp(`^/api/v1/ai/jobs/${ID}/pause$`)],
  ['DELETE', /^\/api\/v1\/ai\/faces$/],
  ['DELETE', new RegExp(`^/api/v1/galleries/${ID}$`)],
  ['POST', new RegExp(`^/api/v1/galleries/${ID}/link/replace$`)],
  ['POST', new RegExp(`^/api/v1/galleries/${ID}/passcode$`)],
  ['POST', new RegExp(`^/api/v1/galleries/${ID}/photos$`)], // the route refuses additions
  ['DELETE', new RegExp(`^/api/v1/me/branding/${ID}$`)],
];

const isWrite = (m: string) => m !== 'GET' && m !== 'HEAD' && m !== 'OPTIONS';

/** True when this request is a write that read-only mode refuses outright. */
export function readOnlyBlocks(method: string, path: string): boolean {
  if (!isWrite(method)) return false;
  const p = path.length > 1 ? path.replace(/\/+$/, '') : path;
  if (!GATED.some((g) => p === g || p.startsWith(`${g}/`))) return false;
  return !ALLOWED.some(([m, re]) => m === method && re.test(p));
}

export const readOnlyAnswer = (c: Parameters<MiddlewareHandler<HonoEnv>>[0]) =>
  c.json(fail('read_only_mode'), 503, { 'Retry-After': '60' });

/** App-wide gate for read-only mode (status cached 15 s per isolate). */
export const readOnlyGate: MiddlewareHandler<HonoEnv> = async (c, next) => {
  if (readOnlyBlocks(c.req.method, c.req.path) && (await isReadOnly(c.env))) return readOnlyAnswer(c);
  await next();
};
