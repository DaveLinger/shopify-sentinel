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

## Server

- Fetches all pages from Shopify internally; serves a single combined `{ products: [...] }` response
- Stale-while-revalidate: serves cached data immediately, refreshes in background when TTL (10 min) is exceeded
- Cold start blocks until first fetch completes
- `fetching` flag prevents concurrent refreshes
- `POST /api/cache/invalidate` forces a full refresh and returns `{ ok, count }` when complete
- `X-Cache: HIT | STALE | MISS` header on product responses
- UI config (`HEADER_TITLE`, `SHOW_TYPE_COLUMN`, etc.) is injected into `index.html` at startup as a `CONFIG` script block

## Watcher

- Tracks products in `/data/known_products.json` (persisted via Docker named volume) as `{ [id]: minPrice }`
- Auto-migrates from the legacy `/data/known_ids.json` flat-array format on first run; migrated entries get `null` price so no false price-drop alerts fire
- On first run, loads all current products without sending notifications
- 24-hour `created_at` filter prevents stale products from triggering new-product alerts
- On new products: invalidates server cache (fire-and-forget), then sends Discord notification; out-of-stock new products get a ` ❌ OUT OF STOCK` marker on their alert line (parsed by notify-bot to offer a hot-monitor button)
- On price drops (decrease in `min(variants[].price)` **exceeding $4.99**): sends Discord notification with old → new price plus 30-day-low context from stored history; does not invalidate cache (server refreshes on its own 10-min TTL)
- On restocks (tracked `available` flips false → true after being out of stock ≥ 20 min — `RESTOCK_MIN_OOS_MS` flap damping): invalidates server cache and sends a `Back in Stock` Discord notification. Protected products are skipped. Subject to the availability-accuracy limitation below (`inventory_policy: continue` stores can report false OOS).
- On product removals (product present in `known_products.json` but absent from current fetch): removes from tracking and logs to console (no Discord alert)
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
- **Product removal detection**: Watcher compares fetched product IDs against known IDs each cycle. Products that disappear are removed from tracking and trigger a Discord alert (using stored title).
- **Protected-product suppression**: Some stores (WhiskeyBlendery, BourbonDirect) passcode-protect listings via the Locksmith app, yet those products still appear in `/products.json`. With `CHECK_PRODUCT_VISIBILITY=true`, the watcher fetches the product page on first sighting and inspects the embedded `application/vnd.locksmith+json` state; a passcode-only lock (`remote_lock === true && manual_lock === false`) marks the entry `protected: true`. The check fails open (alerts on any redirect-free fetch error, parse failure, or timeout) and runs only at first sighting to avoid an HTTP request per product per poll. The `protected` flag — persisted in `known_products.json` — gates **both** new-product and price-drop alerts. It is never set for catalogs that leave `CHECK_PRODUCT_VISIBILITY` unset, so their behavior is unchanged.
- **Storage format**: `known_products.json` stores `{ [id]: { price, title, history, available, oosSince?, protected? } }`. Old flat `{ id: price }` format is auto-migrated on first load. (A load-time bug that silently dropped the `protected` flag was fixed 2026-07 — the migration loop now carries `protected`, `available`, and `oosSince` through.)
- **Restock alerts**: per-product `available` (`variants.some(v => v.available)`) is tracked in `known_products.json` from the same 15-min poll — no extra requests. A false→true flip alerts only if `oosSince` is at least `RESTOCK_MIN_OOS_MS` (20 min ≈ 2 polls) old, filtering stores that toggle inventory during fulfillment. Entries without an `available` field (first poll after upgrade) record state silently.
- **Price-drop context**: each drop line appends either `🔻 lowest we've seen in 30 days at this retailer` (when the new price ≤ the 30-day observed low) or the 30-day low for comparison. Computed from the entry's stored history before the drop is recorded.
- **Alert chunking**: `sendDiscordLines()` splits alert posts >1900 chars into multiple webhook messages, repeating the header on each chunk so notify-bot's parser sees complete messages.
- **Jittered polling**: On start, watcher checks immediately, then waits a random 1–15 min before the second check, which anchors all subsequent 15-min polls. This prevents all deployments from hammering Shopify in lockstep when relaunched together via `up-all.sh`.
- **Storage migration**: Watcher auto-migrates from the old flat-array `known_ids.json` to the new `{ id: price }` format in `known_products.json`. Migrated entries get `null` as their price baseline so no false price-drop alerts fire on the first run after upgrade.
