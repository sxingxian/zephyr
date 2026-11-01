# Zephyr

AI photo editing and private passcode galleries, by Midnight Poetry Studio.

| Surface              | URL                                | Code                                    |
| -------------------- | ---------------------------------- | --------------------------------------- |
| Landing page         | zephyr.midnightpoetry.studio       | `apps/landing` (Astro)                  |
| API                  | `/api/*` on both hosts             | `apps/api` (Hono on Cloudflare Workers) |
| App (PWA)            | zephyrapp.midnightpoetry.studio    | `apps/web` (React + Vite)               |
| Admin                | zephyr.midnightpoetry.studio/admin | `apps/admin` (React + Vite)             |
| Database and sign-in | Supabase                           | `supabase/`                             |

Status: **phase 5**: shared galleries (unguessable links, optional passcodes, guest page, favourites, branding,
watermarks, access log, reports) on top of the editor, photo library, accounts, invites and the invite-only landing
page. See [docs/roadmap.md](docs/roadmap.md) and the phase docs in [docs/](docs/).

## Layout

```
apps/
  landing/     Astro site, three.js hero, GSAP + Lenis scroll scenes, invite-request form, landing Worker
  api/         Hono API Worker: sessions (httpOnly cookies), sign-in, invites, admin; reached via service binding
  web/         React + Vite PWA for zephyrapp.midnightpoetry.studio, with its own Worker
  admin/       React + Vite console built into the landing Worker under /admin
packages/
  shared/      HTTP contract, zod schemas, plan limits, settings types (shared by every app and the API)
  ui/          React components on the brand tokens (shared by the app and admin)
  brand/       Colour tokens, icons, logo, mascot poses, sample scenes (exported from design/kit)
supabase/      Migrations (RLS on every table), seed, SQL tests
design/kit/    The design kit that drew the mockups; `pnpm brand:export` regenerates packages/brand
docs/          Architecture, security, setup, roadmap, decisions
```

## Getting started

Requires Node 22.23.4+ (see .nvmrc) and pnpm 10 (`corepack enable`).

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
