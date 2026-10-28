# Working on Zephyr

- Monorepo: pnpm workspaces + Turborepo. Node 22, TypeScript 6, Biome for lint/format (`pnpm format`).
- Plan before changing code; for UI work, mock it up on the design canvases first (see docs/design.md).
- Security comes first:
  - Every new table gets RLS and a SQL test proving `anon`/`authenticated` can't read what they shouldn't.
  - Functions that touch data are `security definer` only when needed, always with `set search_path = ''`.
  - The API is the only thing holding the Supabase service role key. Browsers never get it.
  - Never log emails, raw IPs, tokens or passcodes.
  - The landing domain hosts /admin, so it loads no third-party scripts except Cloudflare Turnstile.
  - Keep `scripts/csp.mjs` passing: no inline event handlers; inline scripts are hashed at build time.
- Shared contracts live in `packages/shared`. Browser code imports `@zephyr/shared/client` (no zod).
- Brand assets come from `design/kit/shared.cjs` via `pnpm brand:export`; don't hand-edit `packages/brand/src/generated`.
- Motion: the markup is always the final layout. Animations are described with data attributes
  (`apps/landing/src/lib/motion.ts`) and played by GSAP; reduced motion and no-JS get the static page.
- Pull requests are switched off on GitHub: work on a branch, then fast-forward `main` once CI passes.
- Before merging: `pnpm lint && pnpm typecheck && pnpm test && pnpm build` and `supabase/tests/run-local.sh`.
