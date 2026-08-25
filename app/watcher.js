// watcher.js
// Unified Shopify product catalog watcher.
// Configured entirely via environment variables — see CLAUDE.md.
//
// Usage:
//   node watcher.js
//
// Runs indefinitely. Use a process manager (pm2, systemd, Docker) to keep it alive.

const https = require('https');
const http = require('http');
const fs = require('fs');
const egress = require('./egress');

// ─── Configuration ────────────────────────────────────────────────────────────

const DISCORD_URL              = process.env.DISCORD_URL || '';
const SHOPIFY_HOST             = process.env.SHOPIFY_HOST;
const SHOPIFY_COLLECTION_PATHS = (process.env.SHOPIFY_COLLECTION_PATH || '/products.json')
  .split(',').map(s => s.trim()).filter(Boolean);
const PROJECT_NAME             = process.env.PROJECT_NAME || 'Catalog';
const PRODUCT_URL_BASE         = process.env.PRODUCT_URL_BASE || ('https://' + SHOPIFY_HOST + '/products/');
const SERVER_HOSTNAME          = process.env.SERVER_HOSTNAME || 'localhost';
const SERVER_PORT              = process.env.PORT || 3000;
const PRODUCT_TAG_FILTER       = process.env.PRODUCT_TAG_FILTER
  ? new Set(process.env.PRODUCT_TAG_FILTER.split(',').map(s => s.trim()).filter(Boolean))
  : null;
const PRODUCT_TYPE_FILTER      = process.env.PRODUCT_TYPE_FILTER
  ? new Set(process.env.PRODUCT_TYPE_FILTER.split(',').map(s => s.trim()).filter(Boolean))
  : null;
const SHOPIFY_STOREFRONT_TOKEN  = process.env.SHOPIFY_STOREFRONT_TOKEN || '';
const CHECK_PRODUCT_VISIBILITY  = process.env.CHECK_PRODUCT_VISIBILITY === 'true';
const INTERVAL_MS               = 15 * 60 * 1000; // 15 minutes
const MIN_PRICE_DROP           = 4.99;           // only alert if drop exceeds this
const RESTOCK_MIN_OOS_MS       = 20 * 60 * 1000; // must be out of stock this long before a restock alerts (flap damping)
const TOMBSTONE_TTL_MS         = 60 * 24 * 60 * 60 * 1000; // how long a delisted product stays tombstoned (see removal handling)
const STORE_PATH               = '/data/known_products.json';
const LEGACY_STORE_PATH        = '/data/known_ids.json';

// ─────────────────────────────────────────────────────────────────────────────

if (!SHOPIFY_HOST) {
  console.error('SHOPIFY_HOST environment variable is required');
  process.exit(1);
}

// Fetches all products from the Shopify API (handles pagination for one collection path)
function fetchPage(collectionPath, page, agent) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: SHOPIFY_HOST,
      path: collectionPath + (collectionPath.includes('?') ? '&' : '?') + 'limit=250&page=' + page,
      method: 'GET',
      agent,
      ...egress.TLS_OPTIONS,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; catalog-watcher/1.0)',
        'Accept': 'application/json'
      }
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error('HTTP ' + res.statusCode + ' on page ' + page + ' of ' + collectionPath));
          return;
        }
        try { resolve(JSON.parse(body)); }
        catch (err) { reject(new Error('Failed to parse response from ' + collectionPath + ': ' + err.message)); }
      });
    });
    req.on('error', err => {
      const e = new Error('Fetch error on ' + collectionPath + ': ' + err.message);
      e.egressCode = err.code; // preserve for tunnel-failure detection
      reject(e);
    });
    req.setTimeout(30000, () => req.destroy(new Error('Request timed out on ' + collectionPath)));
    req.end();
  });
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function fetchPageWithRetry(collectionPath, page) {
  const delays = [10000, 30000]; // retry after 10s, then 30s
  for (let attempt = 0; ; attempt++) {
    try {
      return await egress.viaEgress(
        agent => fetchPage(collectionPath, page, agent),
        collectionPath
      );
    } catch (err) {
      if (err.message.includes('HTTP 429') && attempt < delays.length) {
        console.warn('[' + timestamp() + '] Rate limited (429), retrying in ' + delays[attempt] / 1000 + 's...');
        await sleep(delays[attempt]);
      } else {
        throw err;
      }
    }
  }
}

async function fetchAllFromPath(collectionPath) {
  const all = [];
  let page = 1;
  while (true) {
    const data = await fetchPageWithRetry(collectionPath, page);
    if (!data.products || data.products.length === 0) break;
    all.push(...data.products);
    if (data.products.length < 250) break;
    page++;
    if (page > 10) await sleep(500);
  }
  return all;
}

function postGraphQL(query, variables) {
  return egress.viaEgress(agent => postGraphQLOnce(query, variables, agent), 'graphql');
}

function postGraphQLOnce(query, variables, agent) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ query, variables });
    const options = {
      hostname: SHOPIFY_HOST,
      path: '/api/2023-10/graphql.json',
      method: 'POST',
      agent,
      ...egress.TLS_OPTIONS,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-Shopify-Storefront-Access-Token': SHOPIFY_STOREFRONT_TOKEN,
        'User-Agent': 'Mozilla/5.0 (compatible; catalog-watcher/1.0)',
        'Accept': 'application/json',
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) { reject(new Error('GraphQL HTTP ' + res.statusCode)); return; }
        try {
          const json = JSON.parse(data);
          if (json.errors) reject(new Error('GraphQL errors: ' + JSON.stringify(json.errors)));
          else resolve(json.data);
        } catch (e) { reject(new Error('GraphQL JSON parse error: ' + e.message)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('GraphQL request timed out')));
    req.write(body);
    req.end();
  });
}

function mapGraphQLProduct(node) {
  return {
    id: parseInt(node.id.split('/').pop(), 10),
    title: node.title,
    handle: node.handle,
    product_type: node.productType,
    vendor: node.vendor,
    tags: (node.tags || []).join(', '),
    created_at: node.createdAt,
    images: node.images.edges.map(({ node: img }) => ({ src: img.url })),
    variants: node.variants.edges.map(({ node: v }) => ({
      id: parseInt(v.id.split('/').pop(), 10),
      title: v.title,
      price: v.price.amount,
      available: v.availableForSale,
    })),
  };
}

const STOREFRONT_QUERY = `query GetProducts($cursor: String) {
  products(first: 250, after: $cursor) {
    edges { node {
      id title handle productType vendor tags createdAt
      images(first: 1) { edges { node { url } } }
      variants(first: 10) { edges { node { id title price { amount } availableForSale } } }
    } }
    pageInfo { hasNextPage endCursor }
  }
}`;

async function fetchAllFromStorefront() {
  const all = [];
  let cursor = null;
  while (true) {
    const data = await postGraphQL(STOREFRONT_QUERY, { cursor });
    for (const { node } of data.products.edges) all.push(mapGraphQLProduct(node));
    if (!data.products.pageInfo.hasNextPage) break;
    cursor = data.products.pageInfo.endCursor;
  }
  return all;
}

// Fetches all products, using Storefront GraphQL API if token is set, otherwise REST collection paths
async function fetchAllProducts() {
  let products;
  if (SHOPIFY_STOREFRONT_TOKEN) {
    products = await fetchAllFromStorefront();
  } else {
    const results = await Promise.all(SHOPIFY_COLLECTION_PATHS.map(fetchAllFromPath));
    const seen = new Set();
    products = [];
    for (const batch of results) {
      for (const p of batch) {
        if (!seen.has(p.id)) { seen.add(p.id); products.push(p); }
      }
    }
  }
  return products.filter(p => {
    if (PRODUCT_TAG_FILTER) {
      const tags = (p.tags || '').split(',').map(t => t.trim());
      if (!tags.some(t => PRODUCT_TAG_FILTER.has(t))) return false;
    }
    if (PRODUCT_TYPE_FILTER && !PRODUCT_TYPE_FILTER.has(p.product_type)) return false;
    return true;
  });
}

// Sends a header + lines, splitting into multiple webhook posts if needed to stay
// under Discord's 2000-char message limit. Every chunk repeats the header so
// downstream parsers (notify-bot) see a complete message each time.
async function sendDiscordLines(header, lines) {
  const LIMIT = 1900;
  let batch = [];
  let size = header.length;
  let last = null;
  for (const line of lines) {
    if (batch.length > 0 && size + line.length + 1 > LIMIT) {
      last = await sendDiscord(header + '\n' + batch.join('\n'));
      batch = [];
      size = header.length;
    }
    batch.push(line);
    size += line.length + 1;
  }
  if (batch.length > 0) last = await sendDiscord(header + '\n' + batch.join('\n'));
  return last;
}

// Sends a Discord notification via webhook
function sendDiscord(text) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ content: text });
    const parsed = new URL(DISCORD_URL);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', err => reject(new Error('Discord error: ' + err.message)));
    req.write(body);
    req.end();
  });
}

// Returns false if the product page is passcode-gated by Locksmith (remote_lock:true, manual_lock:false).
// Products with manual_lock:true are accessible to logged-in customers and are treated as public.
// On any network error, timeout, or missing Locksmith data, returns true (assume public — don't suppress).
async function isProductPagePublic(handle) {
  try {
    return await egress.viaEgress(agent => isProductPagePublicOnce(handle, agent), 'product page');
  } catch (err) {
    return true; // network error/timeout on both paths — fail open, as documented above
  }
}

// Rejects (rather than failing open) on connection-level errors so the egress
// wrapper can retry direct; isProductPagePublic applies the fail-open policy.
function isProductPagePublicOnce(handle, agent) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: SHOPIFY_HOST,
      path: '/products/' + handle,
      method: 'GET',
      agent,
      ...egress.TLS_OPTIONS,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; catalog-watcher/1.0)' }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400) {
        res.resume();
        resolve(false);
        return;
      }
      let body = '';
      res.on('data', chunk => {
        body += chunk;
        if (body.length > 524288) { res.destroy(); resolve(true); }
      });
      res.on('end', () => {
        const m = body.match(/application\/vnd\.locksmith\+json[^>]*>(\{[\s\S]*?\})<\/script>/);
        if (!m) { resolve(true); return; }
        try {
          const ls = JSON.parse(m[1]);
          // Passcode-only: no manual lock conditions, only a remote (passcode) key
          resolve(!(ls.remote_lock === true && ls.manual_lock === false));
        } catch (e) { resolve(true); }
      });
    });
    req.on('error', err => {
      const e = new Error('Visibility check failed for ' + handle + ': ' + err.message);
      e.egressCode = err.code;
      reject(e);
    });
    req.setTimeout(10000, () => { req.destroy(new Error('Visibility check timed out for ' + handle)); });
    req.end();
  });
}

// Tells the local server to refresh its cache immediately (fire-and-forget)
function invalidateServerCache() {
  const req = http.request({
    hostname: SERVER_HOSTNAME,
    port: SERVER_PORT,
    path: '/api/cache/invalidate',
    method: 'POST'
  }, (res) => {
    res.resume();
    console.log('[' + timestamp() + '] Server cache invalidated (HTTP ' + res.statusCode + ')');
  });
  req.on('error', err => console.error('[' + timestamp() + '] ERROR invalidating server cache:', err.message));
  req.end();
}

function timestamp() {
  return new Date().toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'medium' });
}

function today() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

// Returns the minimum variant price as a number, or null if unavailable
function minPrice(product) {
  const prices = product.variants
    .map(v => parseFloat(v.price))
    .filter(p => !isNaN(p) && p > 0);
  return prices.length ? Math.min(...prices) : null;
}

function formatPrice(price) {
  return '$' + price.toFixed(2);
}

// True if any variant is purchasable. Subject to the collection-endpoint accuracy
// limitation (inventory_policy: continue stores report false at zero inventory).
function isProductAvailable(product) {
  return product.variants.some(v => v.available);
}

// Lowest price observed in the last 30 days (history entries within window + current price).
function thirtyDayLow(entry) {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const prices = entry.history
    .filter(h => h.date >= cutoff && h.price !== null)
    .map(h => h.price);
  if (entry.price !== null) prices.push(entry.price);
  return prices.length ? Math.min(...prices) : null;
}

// Appends a price change to an entry's history.
// At most one entry per calendar day (later change overwrites the earlier one for that day).
// Capped at 30 entries total.
function addPriceHistory(entry, newPrice) {
  const d = today();
  if (entry.history.length > 0 && entry.history[entry.history.length - 1].date === d) {
    entry.history[entry.history.length - 1].price = newPrice;
  } else {
    entry.history.push({ price: newPrice, date: d });
    if (entry.history.length > 30) entry.history.shift();
  }
  entry.price = newPrice;
}

// Storage format: { [productId]: { price: number|null, title: string|null, history: [{price, date}] } }
function loadKnownProducts() {
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    // Migrate from old flat format { id: price } to new { id: { price, title, history } }
    const result = {};
    for (const [id, val] of Object.entries(raw)) {
      if (val === null || typeof val === 'number') {
        result[id] = { price: val, title: null, history: [] };
      } else {
        result[id] = {
          price:   val.price   ?? null,
          title:   val.title   ?? null,
          history: Array.isArray(val.history) ? val.history : [],
        };
        if (val.protected) result[id].protected = true;
        if (typeof val.available === 'boolean') result[id].available = val.available;
        if (val.oosSince) result[id].oosSince = val.oosSince;
        if (val.removedAt) result[id].removedAt = val.removedAt;
      }
    }
    return result;
  } catch {}
  // Fall back to legacy format (flat array of IDs)
  try {
    const ids = JSON.parse(fs.readFileSync(LEGACY_STORE_PATH, 'utf8'));
    if (Array.isArray(ids)) {
      console.log('[' + timestamp() + '] Migrating from legacy known_ids.json...');
      const migrated = {};
      for (const id of ids) migrated[String(id)] = { price: null, title: null, history: [] };
      return migrated;
    }
  } catch {}
  return {};
}

// Tombstoned entries are bookkeeping, not tracked products — keep them out of counts.
function trackedCount(known) {
  return Object.values(known).filter(e => !e.removedAt).length;
}

function saveKnownProducts(known) {
  try {
    fs.mkdirSync('/data', { recursive: true });
    fs.writeFileSync(STORE_PATH, JSON.stringify(known));
  } catch (err) {
    console.error('[' + timestamp() + '] ERROR saving known products:', err.message);
  }
}

let knownProducts = loadKnownProducts();
let isFirstRun = Object.keys(knownProducts).length === 0;

async function check() {
  console.log('[' + timestamp() + '] Checking for new products and price drops...');

  let products;
  try {
    products = await fetchAllProducts();
  } catch (err) {
    console.error('[' + timestamp() + '] ERROR fetching products:', err.message);
    return;
  }

  const oneDayAgo  = Date.now() - 24 * 60 * 60 * 1000;
  const fetchedIds = new Set(products.map(p => String(p.id)));
  const newProducts    = [];
  const priceDrops     = [];
  const restocks       = [];
  const removedTitles  = [];
  let changed = false;

  // ── Detect removed products ───────────────────────────────────────────────

  // Tombstoned, not deleted: stores that unpublish on sellout drop the product from
  // the feed entirely. A bare delete made the eventual re-publish look like a product
  // never seen before, whose created_at is months old — so it failed the 24h new-product
  // gate and, being a fresh insert, never hit the availability transition either. Both
  // alerts were silently skipped. Keeping the entry lets the return replay as a restock.
  for (const [id, entry] of Object.entries(knownProducts)) {
    if (entry.removedAt) {
      if (Date.now() - entry.removedAt > TOMBSTONE_TTL_MS) {
        delete knownProducts[id];
        changed = true;
      }
      continue;
    }
    if (!fetchedIds.has(id)) {
      removedTitles.push(entry.title || ('Product #' + id));
      entry.removedAt = Date.now();
      changed = true;
    }
  }

  // ── Process current products ──────────────────────────────────────────────

  for (const p of products) {
    const id           = String(p.id);
    const currentPrice = minPrice(p);
    const nowAvail     = isProductAvailable(p);

    if (!(id in knownProducts)) {
      // Never seen before — flag as new if created recently (and not first run)
      let isProtected = false;
      if (!isFirstRun && new Date(p.created_at).getTime() > oneDayAgo) {
        const publiclyAccessible = CHECK_PRODUCT_VISIBILITY ? await isProductPagePublic(p.handle) : true;
        if (publiclyAccessible) newProducts.push(p);
        else { isProtected = true; console.log('[' + timestamp() + '] Skipping notification for protected product: ' + p.title); }
      }
      knownProducts[id] = { price: currentPrice, title: p.title, history: [], available: nowAvail };
      if (!nowAvail) knownProducts[id].oosSince = Date.now();
      // Remember passcode-protected products so later price drops don't alert either
      if (isProtected) knownProducts[id].protected = true;
      changed = true;
    } else {
      const entry      = knownProducts[id];
      const knownPrice = entry.price;

      // Re-published after a delisting. Feed it to the transition logic below as
      // out-of-stock since the moment it vanished, so it alerts as Back in Stock and
      // still gets the usual flap damping.
      if (entry.removedAt) {
        entry.available = false;
        entry.oosSince  = entry.removedAt;
        delete entry.removedAt;
        changed = true;
      }

      // Keep title current
      if (entry.title !== p.title) {
        entry.title = p.title;
        changed = true;
      }

      // Availability transitions. First sighting after upgrade (undefined) just records
      // the state; a false→true flip alerts only if it was out of stock long enough
      // (RESTOCK_MIN_OOS_MS) to filter inventory-toggle flapping.
      if (entry.available === undefined) {
        entry.available = nowAvail;
        if (!nowAvail) entry.oosSince = Date.now();
        changed = true;
      } else if (entry.available && !nowAvail) {
        entry.available = false;
        entry.oosSince = Date.now();
        changed = true;
      } else if (!entry.available && nowAvail) {
        const oosLongEnough = entry.oosSince && (Date.now() - entry.oosSince) >= RESTOCK_MIN_OOS_MS;
        if (oosLongEnough && !entry.protected) {
          restocks.push({ product: p, price: currentPrice });
        }
        entry.available = true;
        delete entry.oosSince;
        changed = true;
      }

      // Price drop detection: must exceed MIN_PRICE_DROP threshold
      // (skip passcode-protected products — flagged when first seen)
      if (knownPrice !== null && currentPrice !== null && currentPrice < knownPrice &&
          (knownPrice - currentPrice) > MIN_PRICE_DROP && !entry.protected) {
        priceDrops.push({ product: p, oldPrice: knownPrice, newPrice: currentPrice, low30: thirtyDayLow(entry) });
      }

      // Record price change in history
      if (entry.price !== currentPrice) {
        addPriceHistory(entry, currentPrice);
        changed = true;
      }
    }
  }

  if (changed) saveKnownProducts(knownProducts);

  if (isFirstRun) {
    isFirstRun = false;
    console.log('[' + timestamp() + '] Initial load: ' + trackedCount(knownProducts) + ' products found. Watching for new additions, price drops, and removals...');
    return;
  }

  // ── Removed products (log only — no Discord alert) ───────────────────────

  if (removedTitles.length > 0) {
    const logMsg = removedTitles.length + ' product' + (removedTitles.length > 1 ? 's' : '') + ' removed from tracking: ' + removedTitles.join(', ');
    console.log('[' + timestamp() + '] ' + logMsg);
  }

  // ── New products ──────────────────────────────────────────────────────────

  if (newProducts.length > 0) {
    const names = newProducts.map(p => p.title).join(', ');
    const logMsg = newProducts.length + ' new product' + (newProducts.length > 1 ? 's' : '') + ' detected: ' + names;
    console.log('[' + timestamp() + '] ' + logMsg);

    invalidateServerCache();

    if (DISCORD_URL) {
      try {
        // CONTRACT: discord-notify-bot parses these messages (parseAlertLine in its
        // bot.js) — header `**<name>: New Products**`, lines `title ($price)
        // [❌ OUT OF STOCK] - url` — to attach hot-monitor buttons and cross-store
        // footnotes. Changing this format silently breaks those replies.
        const productLines = newProducts.map(p => {
          const price = minPrice(p);
          const priceStr = price !== null ? ' (' + formatPrice(price) + ')' : '';
          const oosStr   = isProductAvailable(p) ? '' : ' ❌ OUT OF STOCK';
          return p.title + priceStr + oosStr + ' - ' + PRODUCT_URL_BASE + p.handle;
        });
        const result = await sendDiscordLines('**' + PROJECT_NAME + ': New Products**', productLines);
        console.log('[' + timestamp() + '] Discord notified (HTTP ' + result.status + ')');
      } catch (err) {
        console.error('[' + timestamp() + '] ERROR sending Discord notification:', err.message);
      }
    }
  }

  // ── Restocks ──────────────────────────────────────────────────────────────

  if (restocks.length > 0) {
    const names = restocks.map(r => r.product.title).join(', ');
    console.log('[' + timestamp() + '] ' + restocks.length + ' restock' + (restocks.length > 1 ? 's' : '') + ' detected: ' + names);

    invalidateServerCache();

    if (DISCORD_URL) {
      try {
        const restockLines = restocks.map(r => {
          const priceStr = r.price !== null ? ' (' + formatPrice(r.price) + ')' : '';
          return '🔄 ' + r.product.title + priceStr + ' - ' + PRODUCT_URL_BASE + r.product.handle;
        });
        const result = await sendDiscordLines('**' + PROJECT_NAME + ': Back in Stock**', restockLines);
        console.log('[' + timestamp() + '] Discord notified (HTTP ' + result.status + ')');
      } catch (err) {
        console.error('[' + timestamp() + '] ERROR sending Discord notification:', err.message);
      }
    }
  }

  // ── Price drops ───────────────────────────────────────────────────────────

  if (priceDrops.length > 0) {
    const summary = priceDrops.map(d =>
      d.product.title + ' ' + formatPrice(d.oldPrice) + ' → ' + formatPrice(d.newPrice)
    ).join(', ');
    const logMsg = priceDrops.length + ' price drop' + (priceDrops.length > 1 ? 's' : '') + ' detected: ' + summary;
    console.log('[' + timestamp() + '] ' + logMsg);

    if (DISCORD_URL) {
      try {
        const dropLines = priceDrops.map(d => {
          const lowStr = d.low30 !== null && d.newPrice <= d.low30
            ? ' 🔻 lowest we\'ve seen in 30 days at this retailer'
            : (d.low30 !== null ? ' (30-day low at this retailer: ' + formatPrice(d.low30) + ')' : '');
          return d.product.title + ': ' + formatPrice(d.oldPrice) + ' → ' + formatPrice(d.newPrice) +
            lowStr + ' — ' + PRODUCT_URL_BASE + d.product.handle;
        });
        const result = await sendDiscordLines('**' + PROJECT_NAME + ': Price Drops**', dropLines);
        console.log('[' + timestamp() + '] Discord notified (HTTP ' + result.status + ')');
      } catch (err) {
        console.error('[' + timestamp() + '] ERROR sending Discord notification:', err.message);
      }
    }
  }

  if (newProducts.length === 0 && priceDrops.length === 0 && restocks.length === 0 && removedTitles.length === 0) {
    console.log('[' + timestamp() + '] No changes. Total known: ' + trackedCount(knownProducts));
  }
}

// Spread the *first* check across a random window before settling into the
// fixed interval. The 1–15 min jitter below only desynchronises the ongoing
// cadence — the initial check used to fire immediately in every deployment, so
// relaunching the fleet sent ~160 requests out of a single exit IP at once,
// which is exactly the pattern that gets an IP rate-limited.
const STARTUP_STAGGER_MS = parseInt(process.env.STARTUP_STAGGER_MS || String(60 * 1000), 10);
const staggerMs = Math.floor(Math.random() * STARTUP_STAGGER_MS);

// Random offset (1–15 min) between the first and second check; this anchors the
// fixed interval so deployments stay out of lockstep long-term.
const jitterMs = Math.floor(Math.random() * 15 * 60 * 1000) + 60 * 1000;

console.log('[' + timestamp() + '] Watcher started. First check in ~' + Math.round(staggerMs / 1000) +
  's, then ~' + Math.round(jitterMs / 60000) + ' min, then every ' + (INTERVAL_MS / 60000) + ' min.');
console.log('[' + timestamp() + '] Shopify egress: ' + egress.describe());

(async () => {
  // Wait for the sidecar before the first fetch, so a cold start after a host
  // reboot doesn't silently fall back to the throttled direct connection.
  await egress.waitForProxy();
  if (staggerMs > 0) await sleep(staggerMs);

  await check();
  setTimeout(() => {
    check();
    setInterval(check, INTERVAL_MS);
  }, jitterMs);
})();
