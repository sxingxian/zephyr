import { Hono } from 'hono';
import { fail, logError } from '../http';
import { libraryContext, ownerOf, requireRole } from '../library/context';
import { LIBRARY_LIMITS, libraryGuard, type PurgeItem, purgeNow } from '../library/storage';
import { rpc } from '../supabase';
import type { HonoEnv } from '../types';
import { requireMember } from './session-helpers';

/** /api/v1/trash/*: emptying the Trash (listing it is GET /api/v1/photos?view=trash). */
export const trashRoutes = new Hono<HonoEnv>();
trashRoutes.use('*', libraryGuard(LIBRARY_LIMITS.jsonBodyBytes));
trashRoutes.use('*', requireMember, libraryContext);

trashRoutes.post('/empty', requireRole('purge'), async (c) => {
  try {
    const res = await rpc<{ deleted: number; purge: PurgeItem[] }>(c.env, 'empty_trash', {
      p_owner: ownerOf(c),
    });
    try {
      await purgeNow(c.env, res.purge);
    } catch (err) {
      // Everything is already 'purging' (hidden, still counted); the clean-up job finishes it.
      logError(c.get('requestId'), 'trash_purge', err);
    }
    return c.json({ ok: true, deleted: res.deleted });
  } catch (err) {
    logError(c.get('requestId'), 'trash_empty', err);
    return c.json(fail('server'), 500);
  }
});
