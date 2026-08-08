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

> **Give the internal network an explicit subnet** once you have enough
> deployments to exhaust Docker's default address pools (172.17–31 `/16`s plus
> 192.168.x `/20`s) — past that point `up` fails with `all predefined address
> pools have been fully subnetted`. Add one to the new deployment's network:
>
> ```yaml
> networks:
>   mystore-internal:
>     ipam:
>       config:
>         - subnet: 10.201.N.0/24   # next unused N
> ```
>
> Check what's taken with `grep -h "subnet: 10.201" docker-compose.*.yml`.
> The permanent fix is a `default-address-pools` entry in
> `/etc/docker/daemon.json`, which needs sudo and restarts every container.

3. Start it:

```bash
docker compose -f docker-compose.mystore.yml up -d --build
```

> **Verify collection handles first.** A collection path that doesn't exist
> returns HTTP 200 with an empty `products` array — not a 404 — so a typo'd or
> renamed collection looks like a permanently empty store. Check handles against
> `https://<host>/collections.json` before deploying.

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
| `EGRESS_PROXY` | *(direct)* | SOCKS5 proxy for Shopify-bound requests, e.g. `socks5h://shopify-egress:1055`. See [Egress routing](#egress-routing). |
| `EGRESS_FALLBACK` | `true` | Retry on the direct connection when the proxy is unreachable. Set to `false` to fail instead. |
| `EGRESS_WAIT_MS` | `90000` | How long to wait at startup for the proxy to be routing before giving up and proceeding direct. See [Startup behaviour](#startup-behaviour). |
| `STARTUP_STAGGER_MS` | `60000` | Random 0–N ms delay before a watcher's first check, to spread a fleet restart. `0` disables. |

## API

```
GET  /api/products.json      → { products: [...] }
GET  /api/health             → { ok, starting?, count, cacheAgeSeconds, fetching }
POST /api/cache/invalidate   → { ok, count }
```

Response header `X-Cache: HIT | STALE | MISS` indicates whether the response was served from cache.

**Monitor `/api/health`, not `/api/products.json`.** The products endpoint serves from cache but starts a background Shopify refresh once the TTL has passed, so polling it for liveness *causes* upstream fetches — a monitor checking every store hourly will generate one refresh per store per check. `/api/health` reports the same liveness with no side effects, and tells you more: `cacheAgeSeconds` reveals a server that is up and answering but has silently stopped refreshing, which a 200 from the products endpoint looks identical to.

It returns 200 while `starting` (the cache fills lazily, so an unwarmed cache is normal for a freshly deployed server and shouldn't alert), and 503 once past `HEALTH_COLD_GRACE_MS` (default 45 min) with the cache still empty.

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

## Egress routing

Shopify's edge limiter returns `HTTP 429 local_rate_limited`. Two independent
factors drive it, and request volume is usually not one of them — a fleet issuing
well under a hundred requests per polling cycle can still be throttled almost
continuously.

**Exit IP reputation.** Many datacenter and VPS ranges are throttled regardless
of how little traffic they send. Stores that refuse one host will answer another
from the same second. Routing through a residential exit node resolves it: on
interleaved samples across 8 stores, this project measured **8/24 success from a
VPS range vs 24/24 through a residential exit node**.

**TLS fingerprint.** Node's default ClientHello (52 ciphers, no ALPN — JA4
`t13d521100`) is fingerprinted and throttled far more aggressively than curl's
(30 ciphers with ALPN — `t13d3012h2`). Holding exit IP, User-Agent and HTTP
version constant, this was **0/5 success without ALPN and 5/5 with**. The fix is
in `egress.js`: `ALPNProtocols: ['http/1.1']` on every Shopify request, applied
unconditionally.

Neither alone is sufficient — the fingerprint fix on a throttled IP still only
reached ~25%.

### How it works

Set `EGRESS_PROXY` to a SOCKS5 endpoint and Shopify-bound requests route through
it. On a **connection-level** failure the request is retried once on the direct
connection; HTTP-level failures (429, 404, parse errors) deliberately do *not*
fall back, since a 429 through the proxy is a real rate limit and retrying direct
only burns the worse IP's budget. Discord webhooks and internal cache
invalidation always go direct.

The proxy is never a hard dependency: if it is down, unset, or misconfigured, or
if `socks-proxy-agent` is unavailable, the deployment degrades to direct rather
than failing.

`docker-compose.egress.yml` provides a [Tailscale](https://tailscale.com/)
sidecar exposing SOCKS5, pinned to one exit node. One `tailscaled` holds exactly
one exit node, so routing different stores through different nodes means running
one sidecar per node and pointing stores at them individually.

```bash
docker network create --subnet 10.201.1.0/24 shopify-egress
cp egress.env.example egress.env     # add TS_AUTHKEY and the exit node
docker compose -f docker-compose.egress.yml up -d
scripts/set-egress.sh on             # or: scripts/set-egress.sh on <store>...
```

Verify any deployment's egress with `node egress-selftest.js`, which reports the
observed exit IP and per-store results.

## Startup behaviour

Three mechanisms keep a fleet restart from stampeding the upstream store — worth
understanding together, since they cover different windows:

**Startup stagger** (`STARTUP_STAGGER_MS`, default 60000). Each watcher waits a
random 0–60s before its *first* check. Without this every deployment fetches the
instant it boots: across a 28-store fleet that is ~160 requests leaving a single
exit IP simultaneously, which is exactly the pattern that gets an IP throttled.
Set to `0` to check immediately.

**Poll jitter.** After the first check, each watcher waits a random 1–15 minutes
before the second, which anchors all subsequent 15-minute polls and keeps
deployments out of lockstep long-term.

**Proxy readiness** (`EGRESS_WAIT_MS`, default 90000). When `EGRESS_PROXY` is
set, both processes wait for the proxy to be genuinely routing before their first
fetch — a TCP probe on the SOCKS port *and* a real request through it, because
the listener binds before the tunnel finishes connecting. Compose's `depends_on`
cannot express this: it only references services in the same compose file, and
the proxy sidecar lives in its own. Without the wait, a host reboot races the
sidecar, and the fallback silently drops the fleet onto the throttled direct
connection during cold start — the worst possible moment. On timeout it proceeds
direct rather than failing.

The server fetches lazily on first request rather than at boot, so it adds
nothing to the startup burst; its first fetch awaits the same readiness check.
