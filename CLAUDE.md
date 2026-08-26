# shopify-catalog

Unified Shopify product catalog proxy. A single codebase serving multiple deployments, each configured via an env file.

## Architecture

Two Node.js processes per deployment, running in separate Docker containers:

- **server** (`server.js`) — HTTP proxy/cache on port 3000, served via Traefik
- **watcher** (`watcher.js`) — polls the Shopify API on a jittered 15-minute schedule; alerts on new products and price drops

Both processes read all configuration from environment variables. The `server` and `watcher` containers communicate over a per-deployment internal Docker network (e.g. `sharedpour-internal`, `hiproof-internal`), which fixes a bug in the original codebases where the watcher and server were on different networks and cache invalidation silently failed.

`SHOPIFY_COLLECTION_PATH` accepts a comma-separated list of collection paths. Both server and watcher fetch all paths in parallel and deduplicate by product ID, so a product appearing in multiple collections is only included once.

## Deployments

| Deployment | Compose file | Env file | Traefik host |
|---|---|---|---|
| SharedPour | `docker-compose.sharedpour.yml` | `sharedpour.env` | `sharedpour.linger.dev` |
| Hiproof | `docker-compose.hiproof.yml` | `hiproof.env` | `hiproof.linger.dev` |
| BarrelShoppe | `docker-compose.barrelshoppe.yml` | `barrelshoppe.env` | `barrelshoppe.linger.dev` |
| RemedyLiquor | `docker-compose.remedyliquor.yml` | `remedyliquor.env` | `remedyliquor.linger.dev` |
| CypressCraft | `docker-compose.cypresscraft.yml` | `cypresscraft.env` | `cypresscraft.linger.dev` |
| JazzySwine | `docker-compose.jazzyswine.yml` | `jazzyswine.env` | `jazzyswine.linger.dev` |
| Tipxy | `docker-compose.tipxy.yml` | `tipxy.env` | `tipxy.linger.dev` |
| PrimeBarrel | `docker-compose.primebarrel.yml` | `primebarrel.env` | `primebarrel.linger.dev` |
| BlackwellsWines | `docker-compose.blackwellswines.yml` | `blackwellswines.env` | `blackwellswines.linger.dev` |
| SipWhiskey | `docker-compose.sipwhiskey.yml` | `sipwhiskey.env` | `sipwhiskey.linger.dev` |
| WoodenCork | `docker-compose.woodencork.yml` | `woodencork.env` | `woodencork.linger.dev` |
| NestorLiquor | `docker-compose.nestorliquor.yml` | `nestorliquor.env` | `nestorliquor.linger.dev` |
| MensJournalSpirits | `docker-compose.mensjournalspirits.yml` | `mensjournalspirits.env` | `mensjournalspirits.linger.dev` |
| WhiskeyBlendery | `docker-compose.whiskeyblendery.yml` | `whiskeyblendery.env` | `whiskeyblendery.linger.dev` |
| NashvilleBarrelCo | `docker-compose.nashvillebarrelco.yml` | `nashvillebarrelco.env` | `nashvillebarrelco.linger.dev` |
| DarkArtsWhiskey | `docker-compose.darkartswhiskey.yml` | `darkartswhiskey.env` | `darkartswhiskey.linger.dev` |
| BigThirst | `docker-compose.bigthirst.yml` | `bigthirst.env` | `bigthirst.linger.dev` |
| BourbonOutfitter | `docker-compose.bourbonoutfitter.yml` | `bourbonoutfitter.env` | `bourbonoutfitter.linger.dev` |
| WhiskeyCaviar | `docker-compose.whiskeycaviar.yml` | `whiskeycaviar.env` | `whiskeycaviar.linger.dev` |
| BondedBottleShop | `docker-compose.bondedbottleshop.yml` | `bondedbottleshop.env` | `bondedbottleshop.linger.dev` |
| BourbonDirect | `docker-compose.bourbondirect.yml` | `bourbondirect.env` | `bourbondirect.linger.dev` |
| ElCerritoLiquor | `docker-compose.elcerritoliquor.yml` | `elcerritoliquor.env` | `elcerritoliquor.linger.dev` |
| LuekensLiquors | `docker-compose.luekensliquors.yml` | `luekensliquors.env` | `luekensliquors.linger.dev` |
| OnyxAmber | `docker-compose.onyxamber.yml` | `onyxamber.env` | `onyxamber.linger.dev` |
| DramFellows | `docker-compose.dramfellows.yml` | `dramfellows.env` | `dramfellows.linger.dev` |
| DramCellars | `docker-compose.dramcellars.yml` | `dramcellars.env` | `dramcellars.linger.dev` |
| KingsCountyDistillery | `docker-compose.kingscountydistillery.yml` | `kingscountydistillery.env` | `kingscountydistillery.linger.dev` |
| PreetLiquor | `docker-compose.preetliquor.yml` | `preetliquor.env` | `preetliquor.linger.dev` |

### Deploy commands

```bash
# All deployments
scripts/up-all.sh           # start all
scripts/up-all.sh --build   # start all, rebuilding images
scripts/down-all.sh         # stop all

# Single deployment
docker compose -f docker-compose.<name>.yml up -d --build
```

### Adding a new deployment: explicit subnet required

Docker's default address pools (172.17–31.x /16s + 192.168.x /20s) are fully
subnetted by the existing networks — `up` on a new deployment fails with
`all predefined address pools have been fully subnetted`. Every new
deployment's internal network needs an explicit subnet in its compose file:

```yaml
networks:
  proxy:
    external: true
  <name>-internal:
    ipam:
      config:
        - subnet: 10.201.N.0/24   # next unused N; dramfellows took 10.201.0.0/24
```

Check what's taken with:
`grep -h "subnet: 10.201" docker-compose.*.yml`

Taken so far: `10.201.0.0/24` dramfellows, `10.201.1.0/24` shopify-egress
(created out-of-band), `10.201.2.0/24` dramcellars,
`10.201.3.0/24` kingscountydistillery, `10.201.4.0/24` preetliquor.

**Silent-failure warning:** a collection handle that doesn't exist returns
HTTP 200 with an empty `products` array, not a 404 — so a typo'd or renamed
collection looks like an empty store forever. DarkArtsWhiskey sat at 0 products
this way until 2026-08-04. Verify a new store's handles against
`https://<host>/collections.json` before deploying.

Permanent fix (not yet applied; needs sudo and briefly restarts every container):

```bash
sudo tee /etc/docker/daemon.json <<< '{"default-address-pools":[{"base":"10.201.0.0/16","size":24}]}'
sudo systemctl restart docker
```

## Configuration variables

### Required

| Variable | Description | Example |
|---|---|---|
| `SHOPIFY_HOST` | Shopify store hostname | `sharedpour.com` |

### Optional (with defaults)

| Variable | Default | Description |
|---|---|---|
| `SHOPIFY_COLLECTION_PATH` | `/products.json` | Comma-separated collection path(s); multiple paths are fetched in parallel and deduplicated by product ID. Paths may include query params (e.g. `?tag=varietal-BOURBON`) — pagination params are appended with `&` automatically. Ignored when `SHOPIFY_STOREFRONT_TOKEN` is set. |
| `SHOPIFY_STOREFRONT_TOKEN` | `` (disabled) | Shopify Storefront API access token. When set, uses the GraphQL Storefront API instead of REST collection paths, enabling access to products published only to the Buy Button channel. Use with `PRODUCT_TYPE_FILTER` to scope results. |
| `PRODUCT_TAG_FILTER` | `` (disabled) | Comma-separated list of Shopify tags; when set, only products with at least one matching tag are served |
| `PRODUCT_TYPE_FILTER` | `` (disabled) | Comma-separated list of `product_type` values; when set, only products with a matching type are served |
| `PRODUCT_URL_BASE` | `https://{SHOPIFY_HOST}/products/` | Base URL for product links |
| `PROJECT_NAME` | `Catalog` | Used in notification titles |
| `SERVER_HOSTNAME` | `localhost` | Watcher → server hostname for cache invalidation |
| `PORT` | `3000` | Server port |
| `PAGE_TITLE` | value of `HEADER_TITLE` | Browser tab title |
| `HEADER_TITLE` | `Product Catalog` | `<h1>` text |
| `HEADER_DOMAIN` | value of `SHOPIFY_HOST` | Domain shown in header |
| `SHOW_TYPE_COLUMN` | `true` | Show/hide the Type column and filter |
| `DEFAULT_AVAIL_FILTER` | `` (all) | Pre-select availability filter (`true` = In Stock) |
| `DISCORD_URL` | `` (disabled) | Discord webhook URL |
| `CHECK_PRODUCT_VISIBILITY` | `false` | When `true`, the watcher checks each newly-seen product's page for a passcode-only Locksmith lock and suppresses alerts for protected products. Enabled for WhiskeyBlendery and BourbonDirect. |
| `HEALTH_COLD_GRACE_MS` | `2700000` (45 min) | How long `/api/health` reports 200 with an unwarmed cache before calling it a failure |
| `EGRESS_PROXY` | `` (direct) | SOCKS5 proxy for Shopify-bound requests, e.g. `socks5h://shopify-egress:1055`. Unset = direct connection. See "Egress and rate limiting" below. |
| `EGRESS_FALLBACK` | `true` | When the tunnel is unreachable, retry the request on the direct connection. Set to `false` to fail instead. |
| `EGRESS_WAIT_MS` | `90000` | Startup wait for the proxy to be routing before proceeding direct. Can overshoot by one probe cycle (~12s). |
| `STARTUP_STAGGER_MS` | `60000` | Random 0–N ms delay before the watcher's first check. `0` = immediate. |

## Server

- Fetches all pages from Shopify internally; serves a single combined `{ products: [...] }` response
- Stale-while-revalidate: serves cached data immediately, refreshes in background when TTL (10 min) is exceeded
- Cold start blocks until first fetch completes
- `fetching` flag prevents concurrent refreshes
- `POST /api/cache/invalidate` forces a full refresh and returns `{ ok, count }` when complete
- `X-Cache: HIT | STALE | MISS` header on product responses
- `GET /api/health` → `{ ok, starting?, count, cacheAgeSeconds, fetching }` — **liveness with no side effects**

### Why /api/health exists (added 2026-08-08)

`GET /api/products.json` answers from cache but starts a background Shopify refresh once the TTL has passed. That makes it the wrong thing to poll for liveness: health-watchdog checking all ~29 stores hourly was *causing* ~29 upstream fetches through the single egress tunnel at the same instant, which was the source of 49 of 60 sampled `tunnel unavailable … falling back to direct connection` warnings (all at `:26`, that pass's offset). The monitoring was manufacturing the anomalies the log digest then reported.

`/api/health` reports the same liveness without touching Shopify, and is a *stronger* check: `cacheAgeSeconds` exposes a server that is up and answering but has silently stopped refreshing — indistinguishable from healthy via a 200 on the products endpoint.

Status codes are deliberate: **200 while `starting`** (the cache fills lazily, so "not warm yet" is the normal state of a just-deployed server and must not alert on every `up-all.sh --build`), and **503 once past `HEALTH_COLD_GRACE_MS`** (default 45 min, comfortably longer than find-bot's 30-minute re-warm) with the cache still empty — by then something has certainly asked, so an empty cache means fetching is genuinely failing. That preserves the failure signal the old products-endpoint 503 provided.
- UI config (`HEADER_TITLE`, `SHOW_TYPE_COLUMN`, etc.) is injected into `index.html` at startup as a `CONFIG` script block

## Watcher

- Tracks products in `/data/known_products.json` (persisted via Docker named volume) as `{ [id]: minPrice }`
- Auto-migrates from the legacy `/data/known_ids.json` flat-array format on first run; migrated entries get `null` price so no false price-drop alerts fire
- On first run, loads all current products without sending notifications
- A populated DB is what prevents backfill spam, not the product's age: any unknown ID alerts regardless of `created_at`. What `created_at` still decides is *which* alert — within 24h it's a `New Products` alert, older than that it's a relist and goes out as `Back in Stock` (see **Delist/relist restocks**). An unknown-but-old product that appears *out of stock* alerts nothing; it's recorded with `oosSince` so the normal transition covers it when it fills.
- On new products: invalidates server cache (fire-and-forget), then sends Discord notification; out-of-stock new products get a ` ❌ OUT OF STOCK` marker on their alert line (parsed by notify-bot to offer a hot-monitor button)
- On price drops (decrease in `min(variants[].price)` **exceeding $4.99**): sends Discord notification with old → new price plus 30-day-low context from stored history; does not invalidate cache (server refreshes on its own 10-min TTL)
- On restocks (tracked `available` flips false → true after being out of stock ≥ 20 min — `RESTOCK_MIN_OOS_MS` flap damping): invalidates server cache and sends a `Back in Stock` Discord notification. Protected products are skipped. Subject to the availability-accuracy limitation below (`inventory_policy: continue` stores can report false OOS).
- On product removals (product present in `known_products.json` but absent from current fetch): tombstones the entry with `removedAt` and logs to console (no Discord alert). Tombstones are dropped after `TOMBSTONE_TTL_MS` (60 days).
- On a bulk influx (more than `BULK_INFLUX_LIMIT` = 25 unknown IDs in a single poll on a non-empty DB): everything is recorded silently and a warning is logged instead. This is the guard that the 24-hour `created_at` filter used to provide by accident — it catches a widened `SHOPIFY_COLLECTION_PATH`/`PRODUCT_TAG_FILTER`, a switch to the Storefront API's full catalog, and a truncated fetch that tombstoned half the store. **If you widen a live deployment's scope, expect this warning on the next poll — that's it working.** The check happens before any `isProductPagePublic()` lookups, so it also caps the visibility-fetch burst.
- On re-publish (a tombstoned product reappearing in the feed): replayed through the restock path as out-of-stock since `removedAt`, so it sends a `Back in Stock` notification rather than being silently re-added — **but only if a stock change actually happened.** A product that was in stock when it vanished and is in stock again on return saw no transition at either end; that is a truncated fetch, not a relist, and it is adopted silently (logged as `reappeared with no stock change`). The exception is `INSTOCK_RELIST_MIN_GONE_MS` (6 h): gone longer than that, an in-stock→in-stock return alerts anyway, since no short page explains a six-hour absence. See **Delist/relist restocks** below
- When `CHECK_PRODUCT_VISIBILITY=true`, a newly-seen product gated behind a passcode-only Locksmith lock is added to tracking with `protected: true` and gets **no** new-product alert; the flag also suppresses later price-drop alerts. Visibility is checked once (at first sighting), never re-fetched.
- Price history is stored per product as `{ price, date }` entries: at most one entry per calendar day, capped at 30 entries per product
- Polls on a jittered schedule: checks immediately on start, then waits a random 1–15 min before the second check, which sets the cadence for all subsequent 15-min polls — prevents lockstep polling when all deployments are relaunched at once
- `DISCORD_URL` is optional; set to empty string to disable

## Storefront GraphQL API (SHOPIFY_STOREFRONT_TOKEN)

Some Shopify stores sell products via embedded Buy Buttons that are published only to the Buy Button sales channel, not the Online Store. These products are invisible to `/products.json` and collection REST endpoints but are returned by the Storefront GraphQL API.

When `SHOPIFY_STOREFRONT_TOKEN` is set:
- `SHOPIFY_COLLECTION_PATH` is ignored
- Products are fetched via `POST /api/2023-10/graphql.json` with cursor-based pagination
- The GraphQL response is mapped to the same product shape as the REST API (numeric IDs extracted from GIDs, `productType` → `product_type`, `tags` array → comma-separated string, etc.)
- `PRODUCT_TYPE_FILTER` should be used to scope results (e.g. `Bourbon,Bourbon Whiskey`) since the Storefront API returns the full catalog

The Storefront Access Token is a public token visible in the store's HTML (look for `ShopifyBuy.buildClient({ storefrontAccessToken: '...' })`). BigThirst is currently the only deployment using this method.

## Egress and rate limiting

Shopify's edge limiter returns `HTTP 429 local_rate_limited`. Two independent
factors drive it, measured 2026-08-04:

**1. Exit IP.** The VPS egress (`23.94.99.234`, a ColoCrossing range with poor
reputation) is throttled fleet-wide. Measured on interleaved samples across 8
stores: **8/24 success direct vs 24/24 through a residential Tailscale exit
node**. Volume is not the cause — the whole fleet issues only ~80 requests per
15-minute cycle. Stores we have never polled are throttled identically, and the
same stores answer other networks fine.

**2. TLS fingerprint.** Node's default ClientHello (52 ciphers, no ALPN —
JA4 `t13d521100`) is fingerprinted and throttled far harder than curl's
(30 ciphers with ALPN — `t13d3012h2`). Through the *same* exit IP, User-Agent
and HTTP version: **0/5 success without ALPN, 5/5 with**. `egress.TLS_OPTIONS`
sets `ALPNProtocols: ['http/1.1']` on every Shopify request to fix this.

Neither alone is sufficient — the fingerprint fix on the direct IP still only
reaches ~25%. Both together give a clean 18/18.

### How it works

`app/egress.js` owns this. Shopify-bound requests (`fetchPage`, `postGraphQL`,
`isProductPagePublic`) go through `viaEgress()`, which attaches the SOCKS5 agent
and, on a *connection-level* failure, retries once on the direct connection.
HTTP-level failures (429, 404, parse errors) deliberately do **not** trigger the
fallback — a 429 through the tunnel is a real rate limit, and retrying direct
would only burn the worse IP's budget. Discord webhooks and internal cache
invalidation always go direct.

The tunnel is never a hard dependency: if the sidecar is down, or
`socks-proxy-agent` is missing, or `EGRESS_PROXY` is malformed, the fleet
degrades to direct rather than going blind.

Verify any deployment's egress with:

```bash
docker run --rm --network shopify-egress \
  -e EGRESS_PROXY=socks5h://shopify-egress:1055 \
  shopify-catalog-test node egress-selftest.js
```

### Tailscale sidecar

`docker-compose.egress.yml` runs a Tailscale container exposing SOCKS5 on 1055,
pinned to one exit node. **One tailscaled holds exactly one exit node**, so
per-store exit-node choice means one sidecar per exit node — copy the service
block with a new name, port, `TS_HOSTNAME` and `TS_EXTRA_ARGS`, then point
stores at it individually via `EGRESS_PROXY`.

The fleet exit node is **dad-truenas-scale** (`100.115.249.118`) — verified 24/24 on 2026-08-04.
`home-truenas-scale` (`100.91.141.83`) also tests clean but is already in use
by ytdl; avoid sharing it. Confirm which node is active with
`docker exec shopify-catalog-shopify-egress-1 tailscale status`; the selftest
prints the resulting egress IP.

Setup:

```bash
docker network create --subnet 10.201.1.0/24 shopify-egress   # already created
cp egress.env.example egress.env    # add TS_AUTHKEY (exit node is preset)
docker compose -f docker-compose.egress.yml up -d
scripts/set-egress.sh on            # point all 27 stores at the sidecar
scripts/up-all.sh --build
```

`scripts/set-egress.sh {on|off|status} [store ...]` manages `EGRESS_PROXY`
across store env files, so individual stores can be moved between the tunnel and
the direct path (or onto a second sidecar) without hand-editing.

All store compose files already join `shopify-egress` (via
`scripts/add-egress-network.sh`); membership alone is inert — a store only uses
the tunnel once `EGRESS_PROXY` is set in its env file. Setting `EGRESS_PROXY`
while the sidecar is down is safe but pointless: every request fails the tunnel
and falls back to direct, just with added latency.

## Known limitations

- **Availability accuracy**: The collection `.json` endpoint (`/collections/.../products.json`) returns `available: false` for variants with zero inventory even if the store has "continue selling when out of stock" set. Shopify's `/products/[handle].js` endpoint returns the correct availability in that case, but we don't use it to avoid N per-product requests. As a result, products with `inventory_policy: continue` and zero inventory will show "Out of Stock" in the catalog even though they're purchasable. `DEFAULT_AVAIL_FILTER=true` (set in `hiproof.env`) will also hide these products by default.
- **Cold-start**: If Shopify is unreachable at startup, the server returns a 503 with an error message rather than hanging. A 30s socket timeout is applied to all upstream HTTP requests.

## Key decisions

- **Async cache strategy**: Uses the async/Promise pattern (from Hiproof) rather than the callback pattern (from SharedPour). Cleaner code, the `fetching` flag handles concurrency, and the invalidate endpoint confirms the cache is warm before responding.
- **Server-side pagination**: Server fetches all pages from Shopify and returns a single combined response. Client makes one request instead of paginating itself.
- **Config injection**: Server injects a `CONFIG` JS object into `index.html` at startup rather than using a separate `/api/config` endpoint. This avoids an extra round-trip and keeps the HTML self-contained once served.
- **Internal networks**: Each deployment gets a dedicated internal Docker network so the watcher can reliably reach the server by service name.
- **Multi-collection support**: `SHOPIFY_COLLECTION_PATH` accepts a comma-separated list. Paths are fetched in parallel and deduplicated by product ID. Tracking switched from title to ID to be robust against title changes and to handle products appearing in multiple collections.
- **Query param support in collection paths**: If a collection path already contains `?` (e.g. `/products.json?tag=varietal-BOURBON`), pagination params are appended with `&` instead of `?`.
- **Storefront GraphQL API**: When `SHOPIFY_STOREFRONT_TOKEN` is set, the server and watcher fetch via the Storefront GraphQL API with cursor-based pagination instead of REST. This surfaces Buy Button-only products invisible to the REST API. GraphQL responses are mapped to the same product shape so the rest of the code is unaffected.
- **Product filtering**: Both `PRODUCT_TAG_FILTER` (match any tag) and `PRODUCT_TYPE_FILTER` (match `product_type`) are applied by both the server and watcher, so alerts stay scoped to the same product set shown in the UI.
- **Tags normalization**: The UI normalizes `tags` from a comma-separated string (REST API format) to an array on load, so tag display and search work correctly for any store regardless of whether tags are populated.
- **Price drop tracking**: Watcher stores `min(variants[].price)` per product. A drop only fires an alert if the decrease exceeds **$4.99** (`MIN_PRICE_DROP`) to filter out minor fluctuations. `compare_at_price` is intentionally ignored. Products with only $0 variants have `price: null` (no alerts, no history).
- **Price history**: Stored per product as `history: [{price, date}]` alongside the current price. At most one entry per calendar day (later change for the same day overwrites earlier), capped at 30 entries per product. History only grows on price changes, not on every poll.
- **Product removal detection**: Watcher compares fetched product IDs against known IDs each cycle. Products that disappear are tombstoned (`removedAt` timestamp) and logged to console using the stored title — no Discord alert.
- **Delist/relist restocks**: some stores (SharedPour notably) *unpublish* a product when it sells out rather than flagging it out of stock, so it vanishes from `/products.json` entirely. Deleting the entry on disappearance made the eventual re-publish arrive as an ID the watcher had never seen, whose `created_at` is the original creation date — months old — so it failed the 24h new-product gate, and being a fresh insert it never hit the availability transition either. **Both alerts were silently skipped.** (Diagnosed 2026-08-25: SharedPour's 8/20 09:02–09:32 polls silently absorbed 7 relists, including `THE BONES KY241 9 Year`, created 2026-05-04 and re-published 2026-08-20T09:00.) Removed entries are now tombstoned instead of deleted; on reappearance the watcher sets `available: false` and `oosSince = removedAt`, letting the normal transition logic emit a `Back in Stock` alert with the usual 20-min flap damping. `protected` survives the round trip, so protected products stay silent. Tombstones expire after 60 days (`TOMBSTONE_TTL_MS`), after which a return is treated as a genuinely unseen product again. Tombstoned entries are excluded from the `Total known` log count (`trackedCount()`).

  **Not every disappearance is a delisting** (2026-08-26). On large paginated catalogs the feed itself drops products transiently — elcerritoliquor (3,080 products, 31 pages) shed 1–3 products per poll and returned them 30–75 minutes later, with `Total known` wobbling 3080→3077→3080; whiskeycaviar and nestorliquor showed the same one-product wobble. Replaying those as restocks alerted on bottles that never sold out — the same three El Cerrito listings cycled removed→alert→removed→alert three times in one morning. `RESTOCK_MIN_OOS_MS` does not catch it: the gaps are longer than 20 minutes by construction, since the product has to miss at least two polls to be noticed at all. The tell is that the entry's stored `available` was `true` when it vanished and is `true` on return — **no stock transition at either end, so there is nothing to announce.** The replay is therefore conditional: it runs when the product was known out of stock at removal (`available !== true`, which also covers pre-upgrade entries with no `available` field), or when it has been gone longer than `INSTOCK_RELIST_MIN_GONE_MS` (6 h). The 6-hour escape hatch is what preserves the genuine case of a store that delists the *instant* it sells out and so never publishes the out-of-stock state; observed feed noise tops out around 75 minutes, leaving a wide margin. Suppressed returns are logged with the absence duration and do **not** print `No changes`.

  Tombstones only cover products delisted *after* 2026-08-25. Anything the store pulled before that — or that stays gone past the 60-day TTL — returns as an ID the watcher has no record of, which is why the 24h `created_at` gate was dropped the same day (2026-08-25): an unknown ID now alerts on its own merits, with `created_at` choosing the label rather than granting permission. The two mechanisms cover the same event from opposite ends, and both land on `Back in Stock`. The spam guard that the date gate was really providing is now `BULK_INFLUX_LIMIT` (see **Watcher**).
- **Protected-product suppression**: Some stores (WhiskeyBlendery, BourbonDirect) passcode-protect listings via the Locksmith app, yet those products still appear in `/products.json`. With `CHECK_PRODUCT_VISIBILITY=true`, the watcher fetches the product page on first sighting and inspects the embedded `application/vnd.locksmith+json` state; a passcode-only lock (`remote_lock === true && manual_lock === false`) marks the entry `protected: true`. The check fails open (alerts on any redirect-free fetch error, parse failure, or timeout) and runs only at first sighting to avoid an HTTP request per product per poll. The `protected` flag — persisted in `known_products.json` — gates **both** new-product and price-drop alerts. It is never set for catalogs that leave `CHECK_PRODUCT_VISIBILITY` unset, so their behavior is unchanged.
- **Storage format**: `known_products.json` stores `{ [id]: { price, title, history, available, oosSince?, protected?, removedAt? } }`. Old flat `{ id: price }` format is auto-migrated on first load. (A load-time bug that silently dropped the `protected` flag was fixed 2026-07 — the migration loop now carries `protected`, `available`, `oosSince`, and `removedAt` through.)
- **Restock alerts**: per-product `available` (`variants.some(v => v.available)`) is tracked in `known_products.json` from the same 15-min poll — no extra requests. A false→true flip alerts only if `oosSince` is at least `RESTOCK_MIN_OOS_MS` (20 min ≈ 2 polls) old, filtering stores that toggle inventory during fulfillment. Entries without an `available` field (first poll after upgrade) record state silently.
- **Price-drop context**: each drop line appends either `🔻 lowest we've seen in 30 days at this retailer` (when the new price ≤ the 30-day observed low) or the 30-day low for comparison. Computed from the entry's stored history before the drop is recorded.
- **Alert chunking**: `sendDiscordLines()` splits alert posts >1900 chars into multiple webhook messages, repeating the header on each chunk so notify-bot's parser sees complete messages.
- **Jittered polling**: after the first check, the watcher waits a random 1–15 min before the second, which anchors all subsequent 15-min polls and keeps deployments out of lockstep long-term. Note this only ever covered the *ongoing* cadence — the first check used to fire immediately in every deployment (~160 simultaneous requests fleet-wide), which `STARTUP_STAGGER_MS` now spreads over 0–60s. Measured on the 2026-08-04 rollout: 28 first-checks spread across 1–58s.
- **Proxy readiness at startup**: `egress.waitForProxy()` blocks the first fetch until the sidecar is genuinely routing — a TCP probe on the SOCKS port *and* a real request through it, since the listener binds before tailscaled finishes connecting (verified: a TCP listener that accepts but doesn't route is correctly rejected). Compose `depends_on` cannot express this — it only resolves services within the same compose file, and the sidecar lives in its own; confirmed with `service "x" depends on undefined service "shopify-egress"`. Without the wait a host reboot races the sidecar and the fallback silently drops the fleet onto the throttled direct connection during cold start. The server fetches lazily on first request, so it contributes nothing to the boot burst; its first fetch awaits the same promise.
- **Storage migration**: Watcher auto-migrates from the old flat-array `known_ids.json` to the new `{ id: price }` format in `known_products.json`. Migrated entries get `null` as their price baseline so no false price-drop alerts fire on the first run after upgrade.
