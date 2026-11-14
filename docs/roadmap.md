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
| 8     | Admin portal: users, safety, AI controls, plan limits, ads, audit, roles; Cloudflare Access on /admin; storage provider switch (R2, another S3-compatible cloud service, or on-premises storage) | Next   |

## Phase 8 note: switching storage provider

Requested 2026-11-01. In Admin › Storage, an Owner can move photo storage from Cloudflare R2 to another provider.
Design points to settle in phase 8:

- **Providers:** S3-compatible services in the cloud (for example AWS S3, Backblaze B2, Wasabi) or on premises (an
  S3-compatible object store you run yourself, for example Ceph RGW or Garage; check each one's licence and support
  status in phase 8). Credentials are stored as Worker secrets, never in the database or the admin UI after saving.
  Encryption at rest (SRS NFR-SEC-02) must be on.
- **On premises:** the API runs on Cloudflare, so an on-premises store is reached through a Cloudflare Tunnel
  (`cloudflared`) on its own hostname. No inbound ports are opened, and the hostname only accepts requests from the
  API Worker (a Cloudflare Access service token or a WAF rule, plus the S3 signature). Before switching, the admin
  screen runs a health check covering reachability, a signed write/read/delete round trip and upload speed. Because
  uploads stream through the Worker, the site's uplink sets the upload speed.
  - **Owner's responsibility:** durability (redundancy, backups), monitoring and capacity. The admin screen shows
    free space and alerts below 15%.
  - **Outage:** if the store becomes unreachable, Zephyr turns uploads off, shows a clear notice, and keeps serving
    whatever the Cloudflare cache still holds.
- **Switching:** each object records which store holds it. A switch sends new uploads to the new store at once, and
  a background job copies existing objects, verifies each one by checksum, and only then deletes the old copy. It
  can be paused and rolled back, and every step goes to the audit log. Switching needs two Owners, like plan-limit
  changes.
- **Guest images:** these keep going through the Cloudflare cache, with the new store (cloud or on-premises, via the
  Tunnel) as the origin behind the media hostname, so CSAM scanning still covers them.
- **Costs:** the admin screen shows the other provider's storage and egress costs before confirming. Moving data out
  of R2 is free, but some providers charge egress on every guest view.
- **Code:** from phase 5 on, new storage code goes through one storage module so the backend can be swapped.
