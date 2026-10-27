# ADR 0001: Monorepo and stack

Date: 2026-10-28 · Status: accepted

## Decision

- pnpm workspaces + Turborepo in one GitHub repo (`sxingxian/zephyr`).
- Landing: Astro (static), with three.js, GSAP and Lenis bundled and self-hosted.
- App and admin: React + Vite (phases 2 and 8).
- API: Hono on Cloudflare Workers, reached same-origin through service bindings.
- Data and auth: Supabase Postgres + Auth with RLS; Cloudflare R2 for photos; Stripe for billing; Turnstile.
- Tooling: TypeScript 6, Biome, Vitest, GitHub Actions.

## Why

- Astro ships near-zero JavaScript for a marketing page that must also host /admin safely; heavy motion loads only
  where it's used.
- Same-origin API removes CORS and keeps cookies host-only.
- One repo keeps the shared contracts (schemas, plan limits, tokens) in lockstep across apps.

## Consequences

- Workers bundles must stay small; zod is kept out of browser bundles via `@zephyr/shared/client`.
- TypeScript is pinned to 6.x until Astro's checker supports 7.
