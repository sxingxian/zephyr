# Setup reference: extra photo stores and AdSense

The end-to-end deployment guide is [DEPLOYMENT.md](DEPLOYMENT.md). This page keeps the two long, optional parts it
links to. Their section numbers (§3.8 and §3.9) are kept because the code and phase docs refer to them.

## 3.8 Extra photo stores (phase 8, storage switch)

Cloudflare R2 (the `PHOTOS` binding, store id `r2`) always exists. Admin › Storage can move the photo library to
another store, one photo at a time, with every copy verified by SHA-256 and the old copies kept for 7 days. Stores
are declared **only in the deployment**: the `STORAGE_STORES` var lists them (no credentials), and their keys are
Worker secrets. Nothing about a store can be added or edited from the admin screen, and its endpoint, bucket and
keys never reach the database or a browser.

Guest renditions and branding (`zephyr-shared`) and full-size gallery renders stay on R2 whatever the switch says:
the media host's cache and Cloudflare's CSAM Scanning Tool sit in front of them.

**Every store, cloud or on premises:**

1. **Bucket:** a private bucket used only by Zephyr. No public access, no website hosting, no versioning (old
   copies are deleted on purpose), no lifecycle rules on `u/`. You don't need a `staging/` rule: the clean-up job
   deletes staged variants older than 2 days on every store other than R2 (one page per store per run). If the store
   supports lifecycle rules, one that empties `staging/` after 2 days is a harmless extra.
2. **Key:** an access key limited to that one bucket, with list, read, write, delete and multipart permissions.
3. **Encryption at rest (NFR-SEC-02):** confirm it, then declare `"encryptionAtRest": true`. Zephyr can't check it
   from outside, and refuses to switch to a store that doesn't declare it. Cloud S3 services encrypt by default
   (check the bucket's setting). On premises, use encrypted disks (LUKS or ZFS native encryption): Garage, for
   one, doesn't encrypt on its own.
4. **Capacity:** for a store with a fixed size (on premises), declare `"capacityBytes"`. Admin shows the free space
   (capacity minus what Zephyr stores there) and marks the store degraded below 15% free.
5. **Cost:** `"costPerTbMonthUsd"` and `"egressNote"` feed the cost comparison in Admin › Storage.
6. **Declare it** in `apps/api/wrangler.jsonc` `vars.STORAGE_STORES` (a JSON array; see the example there):
   `id` (a lower-case letter, then lower-case letters, digits and dashes; 2-32 characters; never reused for a different store), `name`, `kind` (`"s3"`),
   `connection` (`"https"`, `"vpc"` or `"tunnel"`), `endpoint`, `bucket`, `region`, `pathStyle`, `binding` (VPC
   only), `costPerTbMonthUsd`, `egressNote`, `capacityBytes`, `encryptionAtRest`. An invalid list leaves only `r2`
   working and shows `config_invalid` in Admin.
7. **Secrets** (`<ID>` is the id upper-cased, dashes to underscores; `studio-nas` → `STUDIO_NAS`):

   ```sh
   pnpm exec wrangler secret put STORE_<ID>_ACCESS_KEY_ID
   pnpm exec wrangler secret put STORE_<ID>_SECRET
   ```
8. **Queue** (once): `pnpm exec wrangler queues create zephyr-storage` and
   `pnpm exec wrangler queues create zephyr-storage-dlq`.
9. **Deploy, then check:** Admin › Storage › the store › **Run check** (a signed write/read/delete round trip, a 4 MB
   upload speed test and free space). The switch is offered only after a passing check in the last 24 hours. The
   switch itself needs a passkey sign-in in the last 10 minutes and emails every Owner.
10. **Retiring a store:** keep it declared (and reachable) until Admin › Storage shows no photos and no old copies
    on it. If it dies for good while old copies still wait there, or while old copies elsewhere wait to be checked
    against it, an Owner can **Abandon** them (passkey; Zephyr checks the stores again and refuses if they answer,
    and a store no longer declared counts only while the config parses): the migration finishes and a new switch
    can start, but nothing is deleted on that store. Don't wipe it
    by hand if it comes back: some copies may be the only copy of an edit or mask made while photos moved. Declare
    it again and let the orphan sweep run; it copies anything a photo's own store is missing over before deleting
    the rest. If a **rollback** fails because the store it rolls back to is gone for good, an Owner can **Give up
    rollback** (passkey): uploads go back to the store the photos had moved to, photos not copied back stay
    there, and photos already copied back return there too unless they were edited after the copy back (those
    stay on the dead store; Admin › Storage lists them).

**A cloud S3 store** (AWS S3, Backblaze B2, Wasabi, and so on): `"connection": "https"`, the provider's HTTPS
endpoint (no bucket in it), its region, and `"pathStyle": false` where the provider supports virtual-host
addressing (most do; set `true` otherwise). Plain `http` endpoints are refused.

**An on-premises store.** Run an S3-compatible server on the studio's own hardware. We recommend
[Garage](https://garagehq.deuxfleurs.fr/) (small, built for self-hosting, replicates across a few machines). Ceph
RGW (for an existing Ceph cluster) and SeaweedFS also work. Don't use MinIO: its community edition was archived in
2026 and gets no more fixes. Use path-style addressing (`"pathStyle": true`) unless you've set up a root domain for
virtual-host buckets. Then pick how the Worker reaches it; neither needs a port open to the internet.

- **Workers VPC (default; beta, free during the beta):** a private link with no public hostname at all.
  1. Dashboard › Workers VPC › Tunnels › **Create**, then install `cloudflared` on a machine next to the store with
     the command the dashboard shows.
  2. Create the service:
     `pnpm exec wrangler vpc service create zephyr-garage --type http --tunnel-id <TUNNEL_ID> --hostname garage.internal --http-port 3900`
     (or `--ipv4 10.0.0.5` instead of `--hostname`). Note the service id it prints.
  3. Add the binding to `wrangler.jsonc`:
     `"vpc_services": [{ "binding": "VPC_GARAGE", "service_id": "<SERVICE_ID>", "remote": true }]`.
  4. Declare the store with `"connection": "vpc"`, `"binding": "VPC_GARAGE"` and the internal endpoint, for example
     `"endpoint": "http://garage.internal:3900"`. Plain `http` is allowed only here: the tunnel carries it
     encrypted, and requests are still SigV4-signed. Requests are signed for the endpoint's host name, so use the
     name the store expects (and run the Admin check, which fails on a signature mismatch).
- **Tunnel hostname behind Cloudflare Access (fallback, if Workers VPC isn't available):**
  1. Create a Cloudflare Tunnel with a public hostname, for example `s3.studio.example.com` → `http://localhost:3900`.
  2. Zero Trust › Access › Applications: protect that hostname with a **Service Auth** policy that allows only a new
     **service token** (Access › Service credentials). Nothing else may reach it.
  3. Declare the store with `"connection": "tunnel"` and `"endpoint": "https://s3.studio.example.com"`.
  4. Add the service token as secrets too:

     ```sh
     pnpm exec wrangler secret put STORE_<ID>_ACCESS_CLIENT_ID
     pnpm exec wrangler secret put STORE_<ID>_ACCESS_CLIENT_SECRET
     ```

**Removing a store:** only once Admin shows it holds no photos and no migration involves it. Delete its
`STORAGE_STORES` entry and its secrets. Photos still on a store the deployment no longer declares show it as
unreachable.

## 3.9 Google AdSense (phase 8, optional; Free plan only)

AdSense stays off until an Owner turns it on in Admin › Ads with a passkey. The Owner accepted the risk that
Google's script runs inside the app with a Free member's privileges (`docs/security.md` item 18). Before you turn
it on:

1. Get the site approved in AdSense and create one display ad unit per placement you use (Library grid, sidebar,
   batch queue). Enter the publisher id (`ca-pub-…`) and the unit ids in Admin › Ads.
2. In AdSense › Privacy & messaging, publish Google's certified consent message for the EEA, the UK and
   Switzerland, and have counsel review it.
3. **In the AdSense console, keep Auto ads off, and with it anchor ads, vignette ads and side rails.** The app
   can't enforce this. Auto ads would place ads outside the allowed placements, including on pages that must never
   show ads. Only the manual units above are allowed.
4. `/ads.txt` is generated by the app Worker from the publisher id while AdSense is on; nothing to upload.
5. Make sure the API Worker has its `AD_DEDUP_SECRET` ([DEPLOYMENT.md §5](DEPLOYMENT.md#5-worker-secrets-and-settings)): it keys the per-member ad event dedup hash and is
   never shared with `IP_HASH_SECRET`.
6. Give both Workers the same `ADS_COOKIE_SECRET` (DEPLOYMENT.md §5 for the API; for the app, `cd apps/web && pnpm exec
   wrangler secret put ADS_COOKIE_SECRET`). It signs the AdSense cookie, and the app Worker widens a page's CSP only
   for a valid one. Without it on either side, AdSense never loads (the strict policy everywhere).
7. Every member adds or removes passkeys and deletes their account from a link emailed through Resend
   (`docs/phase-8.md`, "Account changes only from an emailed link"): check that those emails arrive and that the link
   opens `/account-action/<nonce>` on the app host (`APP_URL`), before launch and before turning AdSense on.
8. **Launch gate:** in current Chrome, Safari and Firefox, check that a library page served with the AdSense policy
   (`Cross-Origin-Opener-Policy: same-origin-allow-popups`) can't read a same-origin popup it opens onto another app
   page (`same-origin`): `window.open('/settings')` from the console, then `w.document` must throw or be null.
   Also check `/account-action`, `/settings/security`, `/settings/billing` and `/share/new` are served with
   `same-origin`. (`noopener-allow-popups` isn't used: browsers that don't know it fall back to `unsafe-none`.)
