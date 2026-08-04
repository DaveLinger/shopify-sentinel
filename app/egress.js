// egress.js
// Optional SOCKS5 egress for Shopify-bound requests, with automatic fallback
// to the host's direct connection when the tunnel is unavailable.
//
// Why: the VPS egress IP (a ColoCrossing range) is throttled by Shopify's edge
// limiter — measured at ~33% success direct vs 100% through a residential exit
// node. Routing store fetches through a Tailscale exit node fixes it, but the
// tunnel must never become a hard dependency: if it goes down we degrade to the
// direct path rather than going blind.
//
// Only Shopify-bound traffic is proxied. Discord webhooks and internal
// server-cache invalidation always go direct.
//
// Config:
//   EGRESS_PROXY    socks5h://host:port  (empty/unset = direct, current behaviour)
//   EGRESS_FALLBACK 'false' to disable the direct fallback (default: enabled)

const net = require('net');
const https = require('https');

const EGRESS_PROXY = (process.env.EGRESS_PROXY || '').trim();
const EGRESS_FALLBACK = process.env.EGRESS_FALLBACK !== 'false';
// How long to wait at startup for the proxy sidecar to become usable.
const EGRESS_WAIT_MS = parseInt(process.env.EGRESS_WAIT_MS || String(90 * 1000), 10);

// TLS options applied to every Shopify-bound request.
//
// Node's default ClientHello (52 ciphers, no ALPN — JA4 t13d521100) is
// fingerprinted by Shopify's edge and rate-limited far more aggressively than
// curl's (30 ciphers with ALPN — JA4 t13d3012h2). Measured against tipxy.com
// through the same exit IP and User-Agent: 0/5 success without this, 5/5 with.
// Advertising ALPN brings the handshake in line; 'http/1.1' (not h2) because
// the https module speaks HTTP/1.1 only.
//
// This helps on the direct connection too, but only marginally (~25% success) —
// the exit IP is the dominant factor, so it is a complement to EGRESS_PROXY,
// not a replacement for it.
const TLS_OPTIONS = { ALPNProtocols: ['http/1.1'] };

let proxyAgent = null;

if (EGRESS_PROXY) {
  try {
    const { SocksProxyAgent } = require('socks-proxy-agent');
    proxyAgent = new SocksProxyAgent(EGRESS_PROXY, { timeout: 30000 });
  } catch (err) {
    // Missing dependency or malformed URL: log loudly but keep running direct.
    // A broken proxy config must not take the whole catalog offline.
    console.error('[egress] EGRESS_PROXY=' + EGRESS_PROXY +
      ' but the proxy agent could not be created (' + err.message + '); using direct connection');
  }
}

// Connection-level failures that mean "the tunnel is not usable right now".
// HTTP-level failures (429, 404, parse errors) are deliberately excluded — a
// 429 through the tunnel is a real rate limit and retrying direct would only
// spend the worse IP's budget.
const TUNNEL_ERROR_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH',
  'ENOTFOUND', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE', 'EPROTO'
]);

function isTunnelFailure(err) {
  if (!err) return false;
  // Callers wrap socket errors in a new Error, so the original code is
  // preserved as `egressCode`.
  const code = err.egressCode || err.code;
  if (code && TUNNEL_ERROR_CODES.has(code)) return true;

  const msg = err.message || '';
  // socks-proxy-agent surfaces connection failures as plain Errors with no
  // `.code`, so the code is only present in the message text.
  for (const c of TUNNEL_ERROR_CODES) {
    if (msg.includes(c)) return true;
  }

  const lower = msg.toLowerCase();
  return lower.includes('socks') || lower.includes('proxy') ||
         lower.includes('socket hang up') || lower.includes('timed out') || lower.includes('timeout');
}

let fallbackCount = 0;
let lastFallbackLog = 0;
const FALLBACK_LOG_INTERVAL_MS = 60 * 1000;

function logFallback(label, err) {
  fallbackCount++;
  const now = Date.now();
  if (now - lastFallbackLog < FALLBACK_LOG_INTERVAL_MS) return;
  lastFallbackLog = now;
  console.warn('[egress] tunnel unavailable for ' + label + ' (' + err.message +
    ') — falling back to direct connection [' + fallbackCount + ' fallback(s) so far]');
}

/**
 * Runs `makeRequest(agent)` through the SOCKS5 tunnel, retrying once on the
 * direct connection if the tunnel itself failed.
 *
 * `makeRequest` receives the agent to attach to the request options, or
 * `undefined` for a direct connection.
 */
async function viaEgress(makeRequest, label) {
  if (!proxyAgent) return makeRequest(undefined);
  try {
    return await makeRequest(proxyAgent);
  } catch (err) {
    if (!EGRESS_FALLBACK || !isTunnelFailure(err)) throw err;
    logFallback(label, err);
    return makeRequest(undefined);
  }
}

// TCP-connect to the SOCKS port. Confirms the sidecar is listening, but not
// that its exit node is up — hence the functional probe below.
function probeListener(timeoutMs) {
  return new Promise(resolve => {
    let host, port;
    try {
      const u = new URL(EGRESS_PROXY);
      host = u.hostname;
      port = Number(u.port) || 1080;
    } catch (err) { return resolve(false); }
    const sock = net.connect({ host, port });
    const done = ok => { sock.destroy(); resolve(ok); };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.on('connect', () => done(true));
    sock.on('error', () => done(false));
  });
}

// Fetch a tiny non-Shopify endpoint through the tunnel. This is what proves the
// exit node is actually routing — the SOCKS listener comes up before tailscaled
// finishes connecting, so a TCP probe alone would let us start too early.
function probeRoute(timeoutMs) {
  return new Promise(resolve => {
    const req = https.request({
      hostname: 'api.ipify.org', path: '/', method: 'GET',
      agent: proxyAgent, ...TLS_OPTIONS
    }, res => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(false); });
    req.end();
  });
}

/**
 * Blocks until the proxy is usable, or `EGRESS_WAIT_MS` elapses.
 *
 * Needed because `depends_on` cannot reference a service in another compose
 * file, so on a host reboot a store can start before the sidecar has connected.
 * Without this the first fetches fail the tunnel, silently fall back to the
 * throttled direct connection, and hit the 429 wall during cold start.
 *
 * Always resolves — never throws. Timing out just means starting on the direct
 * path, which is the pre-existing behaviour.
 *
 * The deadline is checked before each attempt, so the actual wait can overshoot
 * `EGRESS_WAIT_MS` by up to one probe cycle (~12s: 2s listener + 10s route).
 */
async function waitForProxy() {
  if (!proxyAgent) return true;
  const start = Date.now();
  let delay = 1000;
  let waited = false;
  while (Date.now() - start < EGRESS_WAIT_MS) {
    if (await probeListener(2000) && await probeRoute(10000)) {
      if (waited) {
        console.log('[egress] proxy ready after ' + Math.round((Date.now() - start) / 1000) + 's');
      }
      return true;
    }
    waited = true;
    await new Promise(r => setTimeout(r, delay));
    delay = Math.min(Math.round(delay * 1.5), 10000);
  }
  console.warn('[egress] proxy not ready after ' + Math.round(EGRESS_WAIT_MS / 1000) +
    's — starting anyway; requests will fall back to the direct connection');
  return false;
}

function describe() {
  if (!EGRESS_PROXY) return 'direct (no EGRESS_PROXY set)';
  if (!proxyAgent) return 'direct (EGRESS_PROXY set but agent unavailable)';
  return EGRESS_PROXY + (EGRESS_FALLBACK ? ' with direct fallback' : ' with fallback disabled');
}

function stats() {
  return { proxy: EGRESS_PROXY || null, active: !!proxyAgent, fallbacks: fallbackCount };
}

module.exports = { viaEgress, describe, stats, isTunnelFailure, waitForProxy, TLS_OPTIONS };
