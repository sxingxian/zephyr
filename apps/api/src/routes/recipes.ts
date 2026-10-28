import { recipeCreateSchema, recipePatchSchema, type SavedRecipe } from '@zephyr/shared';
import { type Context, Hono, type MiddlewareHandler } from 'hono';
import { fail, logError, rateLimited, readBody } from '../http';
import { expectedUser, LIBRARY_LIMITS, libraryGuard, UUID } from '../library/storage';
import { rpc } from '../supabase';
import type { HonoEnv } from '../types';
import { requireMember } from './session-helpers';

/**
 * /api/v1/recipes/*: a member's saved recipes (at most 200; never a crop). Zephyr's own recipes ship in
 * code (BUILT_IN_RECIPES) and aren't stored.
 */
export const recipeRoutes = new Hono<HonoEnv>();
recipeRoutes.use('*', libraryGuard(LIBRARY_LIMITS.jsonBodyBytes));
recipeRoutes.use('*', requireMember);

type Ctx = Context<HonoEnv>;
const ownerOf = (c: Ctx) => c.get('session').userId;

const writes: MiddlewareHandler<HonoEnv> = async (c, next) => {
  if (c.req.method === 'GET' || c.req.method === 'HEAD') return next();
  if (!(await c.env.EDIT_LIMITER.limit({ key: `edit:${ownerOf(c)}` })).success) return rateLimited(c, 60);
  return expectedUser(c, next);
};
recipeRoutes.use('*', writes);

recipeRoutes.get('/', async (c) => {
  try {
    const recipes = await rpc<SavedRecipe[]>(c.env, 'list_recipes', { p_owner: ownerOf(c) });
    return c.json({ ok: true, recipes });
  } catch (err) {
    logError(c.get('requestId'), 'recipes_list', err);
    return c.json(fail('server'), 500);
  }
});

recipeRoutes.post('/', async (c) => {
  const body = await readBody(c, recipeCreateSchema);
  if (!body) return c.json(fail('invalid'), 400);
  try {
    const res = await rpc<(SavedRecipe & { error?: never }) | { error: string }>(c.env, 'create_recipe', {
      p_owner: ownerOf(c),
      p_name: body.name,
      p_recipe: body.recipe,
    });
    if ('error' in res && res.error === 'limit') return c.json(fail('quota_exceeded'), 409);
    if ('error' in res && res.error) return c.json(fail('invalid'), 400);
    return c.json({ ok: true, recipe: res }, 201);
  } catch (err) {
    logError(c.get('requestId'), 'recipe_create', err);
    return c.json(fail('server'), 500);
  }
});

recipeRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id');
  if (!UUID.test(id)) return c.json(fail('not_found'), 404);
  const body = await readBody(c, recipePatchSchema);
  if (!body) return c.json(fail('invalid'), 400);
  try {
    const res = await rpc<(SavedRecipe & { error?: never }) | { error: string } | null>(
      c.env,
      'update_recipe',
      {
        p_owner: ownerOf(c),
        p_id: id,
        p_name: body.name ?? null,
        p_recipe: body.recipe ?? null,
      },
    );
    if (!res) return c.json(fail('not_found'), 404);
    if ('error' in res && res.error) return c.json(fail('invalid'), 400);
    return c.json({ ok: true, recipe: res });
  } catch (err) {
    logError(c.get('requestId'), 'recipe_patch', err);
    return c.json(fail('server'), 500);
  }
});

recipeRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id');
  if (!UUID.test(id)) return c.json(fail('not_found'), 404);
  try {
    const ok = await rpc<boolean | null>(c.env, 'delete_recipe', { p_owner: ownerOf(c), p_id: id });
    if (!ok) return c.json(fail('not_found'), 404);
    return c.body(null, 204);
  } catch (err) {
    logError(c.get('requestId'), 'recipe_delete', err);
    return c.json(fail('server'), 500);
  }
});
