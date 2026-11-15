# Roadmap

| Phase | Scope                                                                                                                                                                                            | Status |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| 1     | Monorepo, CI, design tokens and brand, database foundation (settings, plans, invites, requests, audit), API Worker, invite-only landing page with request form                                   | Done   |
| 2     | Accounts: app shell (React + Vite PWA), sign-in (email codes, passkeys), sign-up with invites and codes, member invites, admin › Sign-ups & invites. Google and Apple sign-in deferred           | Done   |
| 3     | Library: uploads through the API into private R2, browser thumbnails and RAW previews, albums, search, favourites, trash, account deletion and clean-up jobs                                     | Done   |
| 4     | Editor: WebGL adjustments, recipes, copy/paste, batch, RAW decoding (Wasm)                                                                                                                       | Done   |
| 5     | Sharing: passcode galleries, guest view, rate limits, expiry and revoke, CSAM scanning route                                                                                                     | Done   |
| 6     | Zephyr AI: on-device features, cloud background removal (after the bake-off), AI Gateway, spend caps                                                                                             | Done   |
| 7     | Billing and teams: Stripe Checkout with Managed Payments, in-app plan changes, Customer Portal, webhooks, top-ups, admin-set prices; Studio team libraries (Owner, Editor, Viewer)               | Done   |
| 8     | Admin portal: users, safety, AI controls, plan limits, ads, audit, roles; Cloudflare Access on /admin; storage provider switch (R2, another S3-compatible cloud service, or on-premises storage) | Done   |

## Phase 8 note: switching storage provider

Requested 2026-11-01 and built in phase 8; see [phase-8.md](phase-8.md) for the final design. Changes from the
note that used to be here: store credentials are declared in deployment config and Worker secrets (never entered in
the admin UI); on-premises stores connect through Workers VPC by default or a Tunnel hostname with an Access service
token; the switch needs a recent passkey and emails every Owner instead of two Owners; guest renditions stay on R2.
