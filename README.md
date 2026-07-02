# shopify-sentinel

Multi-deployment Shopify product catalog proxy with Discord alerts for new products and price drops. A single codebase that can run against any number of Shopify stores, each configured via its own env file and Docker Compose file.

## What it does

Each deployment runs two containers:

- **server** — fetches and caches the store's full product catalog, serving it at `/api/products.json`. Stale-while-revalidate: cached data is served immediately; the cache refreshes in the background when the 10-minute TTL expires. Also serves a browsable product catalog UI at the root URL with in-stock filtering and search.
- **watcher** — polls the Shopify API every ~15 minutes and posts Discord alerts when new products appear or prices drop by more than $4.99.

## Requirements

- Docker + Docker Compose
- [Traefik](https://traefik.io/) reverse proxy for HTTPS and hostname routing
- A Shopify store (any store with a public REST or Storefront API)
- A Discord webhook URL (optional — leave `DISCORD_URL` blank to disable alerts)

## Adding a new store

1. Create an env file (e.g. `mystore.env`):

```env
SHOPIFY_HOST=mystore.com
DISCORD_URL=https://discord.com/api/webhooks/...
PROJECT_NAME=MyStore
HEADER_TITLE=MyStore Catalog
```

2. Copy an existing `docker-compose.<name>.yml` to `docker-compose.mystore.yml` and replace the store name, env file reference, and Traefik hostname throughout.

3. Start it:

```bash
docker compose -f docker-compose.mystore.yml up -d --build
```

## Managing deployments

```bash
# All deployments
scripts/up-all.sh             # start all
scripts/up-all.sh --build     # start all, rebuilding images
scripts/down-all.sh           # stop all

# Single deployment
docker compose -f docker-compose.<name>.yml up -d --build
docker compose -f docker-compose.<name>.yml down
```

## Configuration

### Required

| Variable | Description | Example |
|---|---|---|
| `SHOPIFY_HOST` | Shopify store hostname | `sharedpour.com` |

### Optional

| Variable | Default | Description |
|---|---|---|
| `SHOPIFY_COLLECTION_PATH` | `/products.json` | Comma-separated collection path(s); fetched in parallel and deduplicated by product ID. Supports query params (e.g. `?tag=varietal-BOURBON`). Ignored when `SHOPIFY_STOREFRONT_TOKEN` is set. |
| `SHOPIFY_STOREFRONT_TOKEN` | *(disabled)* | Storefront API access token. When set, uses the GraphQL Storefront API instead of REST — enables access to Buy Button-only products invisible to collection endpoints. Use with `PRODUCT_TYPE_FILTER`. |
| `PRODUCT_TAG_FILTER` | *(disabled)* | Comma-separated tags; only products with at least one matching tag are served. |
| `PRODUCT_TYPE_FILTER` | *(disabled)* | Comma-separated `product_type` values; only products with a matching type are served. |
| `PRODUCT_URL_BASE` | `https://{SHOPIFY_HOST}/products/` | Base URL for product detail links. |
| `PROJECT_NAME` | `Catalog` | Used in Discord notification titles. |
| `SERVER_HOSTNAME` | `localhost` | Watcher → server hostname for cache invalidation. |
| `PORT` | `3000` | Server port. |
| `HEADER_TITLE` | `Product Catalog` | Page heading text. |
| `PAGE_TITLE` | value of `HEADER_TITLE` | Browser tab title. |
| `HEADER_DOMAIN` | value of `SHOPIFY_HOST` | Domain shown in the page header. |
| `SHOW_TYPE_COLUMN` | `true` | Show/hide the Type column and filter in the UI. |
| `DEFAULT_AVAIL_FILTER` | *(all)* | Set to `true` to pre-select the In Stock filter on load. |
| `DISCORD_URL` | *(disabled)* | Discord webhook URL. Leave blank to run without alerts. |

## API

```
GET  /api/products.json      → { products: [...] }
POST /api/cache/invalidate   → { ok, count }
```

Response header `X-Cache: HIT | STALE | MISS` indicates whether the response was served from cache.

## Watcher alerts

| Alert | Condition |
|---|---|
| New product | Product appears that wasn't in the previous fetch and was created within the last 24 hours. Out-of-stock listings are marked `❌ OUT OF STOCK` |
| Price drop | `min(variants[].price)` decreases by more than $4.99 since the last check. Includes 30-day-low context ("lowest we've seen in 30 days at this retailer") from stored history |
| Back in stock | A tracked product's availability flips false → true after being out of stock for at least 20 minutes (flap damping) — detected from the same poll data, no extra requests |

Product removals are detected and removed from tracking silently (no Discord alert). Alerts longer than Discord's message limit are split into multiple webhook posts, each repeating the header.

Price history and availability are stored per product (history: one entry per calendar day, capped at 30) in a Docker named volume in `known_products.json`. State persists across restarts — no duplicate alerts, no false price-drop or restock alerts after a restart.

## Works with (optional integrations)

Fully standalone — the only outputs are the catalog HTTP API and Discord webhook posts. Two sister projects build on those outputs; nothing here depends on them:

- **[bourbon-find-bot](https://github.com/DaveLinger/bourbon-find-bot)** searches all deployments' `/api/products.json` endpoints from Discord (`/find`), auto-discovering them from this repo's compose/env files when it runs on the same host.
- **[discord-notify-bot](https://github.com/DaveLinger/discord-notify-bot)** watches the alert channels for keyword DMs, and parses New Products alerts to offer restock-monitor buttons on out-of-stock listings. The alert line format (`title ($price) [❌ OUT OF STOCK] - url` under a `**<name>: New Products**` header) is therefore a parsing contract — see the comment in `watcher.js` before reformatting it.

## Storefront API (Buy Button products)

Some Shopify stores sell products via embedded Buy Buttons published only to the Buy Button sales channel — these are invisible to REST collection endpoints. Set `SHOPIFY_STOREFRONT_TOKEN` to use the GraphQL Storefront API instead. The access token is public and visible in the store's page HTML (look for `ShopifyBuy.buildClient({ storefrontAccessToken: '...' })`).

## Jittered polling

On startup, each watcher checks immediately, then waits a random 1–15 minutes before the second check, which anchors all subsequent 15-minute polls. This prevents all deployments from hammering Shopify in lockstep when relaunched together via `up-all.sh`.
