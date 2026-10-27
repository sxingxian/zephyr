# Zephyr

AI photo editing and private passcode galleries, by Midnight Poetry Studio.

| Surface              | URL                                | Code                                    |
| -------------------- | ---------------------------------- | --------------------------------------- |
| Landing page         | zephyr.midnightpoetry.studio       | `apps/landing` (Astro)                  |
| API                  | `/api/*` on both hosts             | `apps/api` (Hono on Cloudflare Workers) |
| App (PWA)            | zephyrapp.midnightpoetry.studio    | `apps/web` (next phase)                 |
| Admin                | zephyr.midnightpoetry.studio/admin | `apps/admin` (next phase)               |
| Database and sign-in | Supabase                           | `supabase/`                             |

Status: **phase 1** — foundation and the invite-only landing page with a working invite-request form. See
[docs/roadmap.md](docs/roadmap.md).

## Layout

```
apps/
  landing/     Astro site, three.js hero, GSAP + Lenis scroll scenes, invite-request form, landing Worker
  api/         Hono API Worker (public config, invite requests), reached via service binding
packages/
  shared/      Zod schemas, plan limits, settings types (shared by every app and the API)
  brand/       Colour tokens, icons, logo, mascot poses, sample scenes (exported from design/kit)
supabase/      Migrations (RLS on every table), seed, SQL tests
design/kit/    The design kit that drew the mockups; `pnpm brand:export` regenerates packages/brand
docs/          Architecture, security, setup, roadmap, decisions
```

## Getting started

Requires Node 22 and pnpm 10 (`corepack enable`).

```sh
pnpm install
pnpm dev                     # every app in watch mode
pnpm --filter @zephyr/landing dev
pnpm lint && pnpm typecheck && pnpm test && pnpm build
supabase/tests/run-local.sh  # migrations + SQL tests on a throwaway Postgres (run as non-root)
```

Accounts, keys and the first deploy are described in [docs/setup.md](docs/setup.md).

## Design

The mockups live as Claude design canvases (brand, landing, PWA desktop/phone, admin). Links and decisions are in
[docs/design.md](docs/design.md). The landing page follows the **Invite only · default** page of the landing canvas.

## Security

Read [SECURITY.md](SECURITY.md) and [docs/security.md](docs/security.md) before changing auth, the database or
anything that handles user data.
