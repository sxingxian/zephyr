# Architecture

```
Browser ──► zephyr.midnightpoetry.studio ── landing Worker ──┬── static assets (Astro build, _headers)
                                                             └── /api/* ──service binding──► API Worker
Browser ──► zephyrapp.midnightpoetry.studio ── app Worker (next phase) ── /api/* ──────────► API Worker
                                                                                              │
                                              Cloudflare Turnstile ◄── siteverify ────────────┤
                                              Supabase Postgres (RLS) ◄── PostgREST RPC ──────┘
```

- **Same-origin API.** The API Worker has no public route (`workers_dev` and preview URLs off). Each site Worker
  forwards `/api/*` through a service binding, so there's no CORS and the browser only ever talks to its own origin.
- **Static first.** The landing page is a static Astro build served from Workers static assets. Only `/api/*`
  runs Worker code (`run_worker_first`).
- **Database.** Supabase Postgres with RLS on every table. Browser roles have no table access in phase 1; the API
  calls `security definer` functions with the service role. A `before-user-created` auth hook enforces the
  sign-up mode (invite-only by default).
- **Configuration.** `app_settings` holds sign-up mode, request intake and retention; `plan_limits` holds versioned
  plan limits (Option 1: every limit is edited in Admin). Prices live in Stripe.

Next phases add R2 for photos, Queues and the AI Worker, Stripe webhooks, the PWA and /admin (see roadmap.md).
