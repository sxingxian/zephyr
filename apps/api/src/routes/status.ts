/**
 * GET /api/v1/status (MEMBER8_API.status): read-only mode and the maintenance notice, for the app's banner.
 * No session; public data only (`app_status()`), cached 30 s by browsers and the edge.
 */
import type { AppStatusResult } from '@zephyr/shared';
import { Hono } from 'hono';
import { appStatus } from '../admin/app-status';
import type { HonoEnv } from '../types';

export const statusRoutes = new Hono<HonoEnv>();

statusRoutes.get('/', async (c) => {
  const s = await appStatus(c.env);
  return c.json(
    { ok: true, readOnly: s.readOnly, maintenance: s.maintenance } satisfies AppStatusResult,
    200,
    {
      'Cache-Control': 'public, max-age=30',
    },
  );
});
