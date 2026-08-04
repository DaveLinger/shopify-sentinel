// server.js
// Unified Shopify product catalog proxy server.
// Configured entirely via environment variables — see CLAUDE.md.
//
// Usage:
//   node server.js

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const egress = require('./egress');

const PORT = process.env.PORT || 3000;
const SHOPIFY_HOST = process.env.SHOPIFY_HOST;
const SHOPIFY_COLLECTION_PATHS = (process.env.SHOPIFY_COLLECTION_PATH || '/products.json')
  .split(',').map(s => s.trim()).filter(Boolean);
const PRODUCT_TAG_FILTER = process.env.PRODUCT_TAG_FILTER
  ? new Set(process.env.PRODUCT_TAG_FILTER.split(',').map(s => s.trim()).filter(Boolean))
  : null;
const PRODUCT_TYPE_FILTER = process.env.PRODUCT_TYPE_FILTER
  ? new Set(process.env.PRODUCT_TYPE_FILTER.split(',').map(s => s.trim()).filter(Boolean))
  : null;
const SHOPIFY_STOREFRONT_TOKEN = process.env.SHOPIFY_STOREFRONT_TOKEN || '';
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

if (!SHOPIFY_HOST) {
  console.error('SHOPIFY_HOST environment variable is required');
  process.exit(1);
}

// UI config — injected into index.html at startup
const UI_CONFIG = {
  pageTitle: process.env.PAGE_TITLE || process.env.HEADER_TITLE || 'Product Catalog',
  headerTitle: process.env.HEADER_TITLE || 'Product Catalog',
  headerDomain: process.env.HEADER_DOMAIN || SHOPIFY_HOST,
  productUrlBase: process.env.PRODUCT_URL_BASE || ('https://' + SHOPIFY_HOST + '/products/'),
  showTypeColumn: process.env.SHOW_TYPE_COLUMN !== 'false',
  defaultAvailFilter: process.env.DEFAULT_AVAIL_FILTER || ''
};

// Load and prepare index.html once at startup, injecting config
const htmlTemplate = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const configScript = '<script>const CONFIG = ' + JSON.stringify(UI_CONFIG) + ';</script>';
const indexHtml = Buffer.from(htmlTemplate.replace('<!-- CONFIG -->', configScript));

const cache = { products: null, fetchedAt: 0, fetching: false };

function fetchPage(collectionPath, pageNum, agent) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: SHOPIFY_HOST,
      path: collectionPath + (collectionPath.includes('?') ? '&' : '?') + 'limit=250&page=' + pageNum,
      method: 'GET',
      agent,
      ...egress.TLS_OPTIONS,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; catalog-proxy/1.0)',
        'Accept': 'application/json'
      }
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error('HTTP ' + res.statusCode + ' on page ' + pageNum + ' of ' + collectionPath));
          return;
        }
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error('JSON parse error on page ' + pageNum + ' of ' + collectionPath)); }
      });
    });
    req.on('error', err => {
      const e = new Error('Fetch error on ' + collectionPath + ': ' + err.message);
      e.egressCode = err.code; // preserve for tunnel-failure detection
      reject(e);
    });
    req.setTimeout(30000, () => req.destroy(new Error('Request timed out after 30s')));
    req.end();
  });
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function fetchPageWithRetry(collectionPath, pageNum) {
  const delays = [10000, 30000]; // retry after 10s, then 30s
  for (let attempt = 0; ; attempt++) {
    try {
      return await egress.viaEgress(
        agent => fetchPage(collectionPath, pageNum, agent),
        collectionPath
      );
    } catch (err) {
      if (err.message.includes('HTTP 429') && attempt < delays.length) {
        console.warn('[cache] Rate limited (429), retrying in ' + delays[attempt] / 1000 + 's...');
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
        'User-Agent': 'Mozilla/5.0 (compatible; catalog-proxy/1.0)',
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

async function refreshCache() {
  if (cache.fetching) return;
  cache.fetching = true;
  try {
    const products = await fetchAllProducts();
    cache.products = products;
    cache.fetchedAt = Date.now();
    console.log('[cache] refreshed: ' + products.length + ' products at ' + new Date().toISOString());
  } catch (err) {
    console.error('[cache] refresh failed:', err.message);
  } finally {
    cache.fetching = false;
  }
}

async function serveProducts(res) {
  const stale = cache.products && (Date.now() - cache.fetchedAt) > CACHE_TTL_MS;
  const empty = !cache.products;

  if (empty) {
    try { await refreshCache(); } catch (err) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
      return;
    }
    // refreshCache swallows errors internally; check if fetch actually succeeded
    if (!cache.products) {
      res.writeHead(503, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'Catalog unavailable — upstream fetch failed. Try again shortly.' }));
      return;
    }
  } else if (stale) {
    refreshCache(); // background, serve stale immediately
  }

  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'X-Cache': empty ? 'MISS' : stale ? 'STALE' : 'HIT'
  });
  res.end(JSON.stringify({ products: cache.products }));
}

const server = http.createServer((req, res) => {
  const pathname = url.parse(req.url).pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET' });
    res.end();
    return;
  }

  if (pathname === '/api/products.json') {
    serveProducts(res);
    return;
  }

  if (pathname === '/api/cache/invalidate' && req.method === 'POST') {
    refreshCache().then(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, count: cache.products ? cache.products.length : 0 }));
    }).catch(err => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    });
    return;
  }

  if (pathname === '/' || pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(indexHtml);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log((UI_CONFIG.headerTitle || 'Catalog') + ' running at http://localhost:' + PORT);
  console.log('[egress] Shopify egress: ' + egress.describe());
});
