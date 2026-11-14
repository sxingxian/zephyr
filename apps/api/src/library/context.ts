import {
  LIBRARY_HEADER,
  type LibraryAction,
  type LibraryRole,
  type LibraryState,
  type PlanId,
  roleCan,
} from '@zephyr/shared';
import type { Context, MiddlewareHandler } from 'hono';
import { fail, logError } from '../http';
import { rpc } from '../supabase';
import type { HonoEnv } from '../types';
import { UUID } from './storage';

/**
 * Phase 7 library context (docs/phase-7.md, "Library context (teams) in the API"). Every library-scoped
 * route reads the library owner from here, never from the session or the request: the header only names
 * which library the member asks for, and `library_access` decides whether they may open it and as what.
 */
export interface LibraryContext {
  /** The library owner's user id: the `p_owner` of every library-scoped database call. */
  ownerId: string;
  role: LibraryRole;
  /** The owner's plan (credits, storage and limits are always the owner's). */
  plan: PlanId;
  state: LibraryState;
  /** The member's own library. */
  self: boolean;
}

interface AccessRow {
  role: LibraryRole;
  plan: PlanId;
  state: LibraryState;
}
const ROLES = new Set<string>(['owner', 'editor', 'viewer']);
const STATES = new Set<string>(['active', 'read_only']);

/** The library owner of a library-scoped request (set by `libraryContext`). */
export const ownerOf = (c: Context<HonoEnv>) => c.get('library').ownerId;
/**
 * The signed-in member (the actor), for per-person rate limits and leases. Never a `p_owner`: the grep test
 * in test/library-context.test.ts fails the build if a library route passes it as one.
 */
export const actorOf = (c: Context<HonoEnv>) => c.get('session').userId;

/**
 * Runs after requireMember on every library-scoped route group. Missing header (or the member's own id)
 * means their own library. A malformed header is 400 `invalid`; a library the member can't open (never a
 * member, removed, suspended beyond the seats, Studio lapsed, owner deleted) is 403 `library_unavailable`,
 * and the app switches back to the member's own library.
 */
export const libraryContext: MiddlewareHandler<HonoEnv> = async (c, next) => {
  const self = c.get('session').userId.toLowerCase();
  // <img> tags and download links can't send headers, so GET media URLs in a team library carry
  // ?library=<ownerId> instead (writes always need the header). Session cookies are SameSite, so a
  // cross-site page can't use this to load a team's images with a member's session.
  const method = c.req.method;
  const raw =
    c.req.header(LIBRARY_HEADER) ??
    (method === 'GET' || method === 'HEAD' ? c.req.query('library') : undefined);
  let owner = self;
  if (raw !== undefined && raw.trim() !== '') {
    // Any 8-4-4-4-12 hex id (the same check as every :id route); library_access decides the rest.
    const id = raw.trim().toLowerCase();
    if (!UUID.test(id)) return c.json(fail('invalid'), 400);
    owner = id;
  }
  // Shared devices: a tab left open in a team library by someone else must get session_changed (and reset),
  // not library_unavailable (which would switch the new member to "their own" library in that tab).
  const expected = c.req.header('X-Zephyr-Expected-User');
  if (owner !== self && expected !== undefined && expected.trim().toLowerCase() !== self) {
    return c.json(fail('session_changed'), 409);
  }
  let access: AccessRow | null;
  try {
    access = await rpc<AccessRow | null>(c.env, 'library_access', { p_member: self, p_owner: owner });
  } catch (err) {
    logError(c.get('requestId'), 'library_access', err);
    return c.json(fail('server'), 500);
  }
  // A row that isn't one of ours is treated as no access, never as a guess.
  if (!access || !ROLES.has(access.role) || !STATES.has(access.state)) {
    return c.json(fail('library_unavailable'), 403);
  }
  // Defence in depth: only the owner is ever the owner of a library.
  if ((access.role === 'owner') !== (owner === self)) return c.json(fail('library_unavailable'), 403);
  c.set('library', {
    ownerId: owner,
    role: access.role,
    plan: access.plan,
    state: access.state,
    self: owner === self,
  });
  await next();
  // The same URL answers differently per library: shared caches must key on the header.
  try {
    c.res.headers.append('Vary', LIBRARY_HEADER);
  } catch {
    // Immutable headers (a passed-through upstream response): nothing is cached publicly anyway.
  }
};

/** 403 `role_forbidden` unless the member's role in this library allows `action` (ROLE_CAN). */
export const requireRole =
  (action: LibraryAction): MiddlewareHandler<HonoEnv> =>
  async (c, next) => {
    if (!roleCan(c.get('library').role, action)) return c.json(fail('role_forbidden'), 403);
    await next();
  };

/** Inline form of `requireRole` for routes whose action depends on the body (bulk actions). */
export const roleAllows = (c: Context<HonoEnv>, action: LibraryAction) =>
  roleCan(c.get('library').role, action);

/**
 * 403 `library_read_only` while the library is over its plan's storage (after a lapse or downgrade):
 * uploads, copies, edit saves, AI jobs, new galleries and extensions. Trash, restore, purge and downloads
 * stay open so the owner can get back under.
 */
export const requireWritable: MiddlewareHandler<HonoEnv> = async (c, next) => {
  if (c.get('library').state === 'read_only') return c.json(fail('library_read_only'), 403);
  await next();
};
