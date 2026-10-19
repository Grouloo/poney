// Requests through Tor (SOCKS5 proxy of the tor daemon or of Tor Browser).
//
// "socks5h": host names are resolved by Tor, not by the local DNS, so the sites
// visited do not leak through DNS. Fail closed: when Tor is enabled but cannot
// be reached, the request is refused, never sent in the clear.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import zlib from 'node:zlib';
import { SocksProxyAgent } from 'socks-proxy-agent';

/** tor daemon, then Tor Browser. */
export const TOR_DEFAULT_PORTS = [9050, 9150];

/** DuckDuckGo's onion service: searches never leave the Tor network. */
export const DDG_ONION = 'https://duckduckgogg42xjoc72x3sjasowoarfbgcmvfimaftt6twagswzczad.onion';

export class TorUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TorUnavailableError';
  }
}

function portOpen(host, port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/** Normalizes a configured proxy ("127.0.0.1:9150", "socks5://…") to socks5h://host:port. */
export function normalizeProxy(value) {
  const v = String(value || '').trim();
  if (!v) return null;
  const withScheme = /^[a-z0-9]+:\/\//i.test(v) ? v : `socks5h://${v}`;
  return withScheme.replace(/^socks5:\/\//i, 'socks5h://').replace(/^socks:\/\//i, 'socks5h://');
}

/** The proxy to use: the configured one, else the first local Tor port that answers. */
export async function findTorProxy(configured) {
  const explicit = normalizeProxy(configured);
  if (explicit) {
    const u = new URL(explicit);
    return (await portOpen(u.hostname, Number(u.port) || 9050)) ? explicit : null;
  }
  for (const port of TOR_DEFAULT_PORTS) {
    if (await portOpen('127.0.0.1', port)) return `socks5h://127.0.0.1:${port}`;
  }
  return null;
}

/** The proxy to use, or an explanation of why the request is refused. */
export async function requireTor(configured) {
  const proxy = await findTorProxy(configured);
  if (proxy) return proxy;
  const where = normalizeProxy(configured) || `127.0.0.1:${TOR_DEFAULT_PORTS.join(' ou ')}`;
  throw new TorUnavailableError(`Tor est activé mais injoignable (${where}) : la requête n'a pas été envoyée. Lancez Tor Browser ou le service tor (brew services start tor).`);
}

const agents = new Map();
const agentFor = (proxy) => {
  if (!agents.has(proxy)) agents.set(proxy, new SocksProxyAgent(proxy));
  return agents.get(proxy);
};

function decode(res) {
  const enc = String(res.headers['content-encoding'] || '').toLowerCase();
  if (enc === 'gzip' || enc === 'x-gzip') return res.pipe(zlib.createGunzip());
  if (enc === 'deflate') return res.pipe(zlib.createInflate());
  if (enc === 'br') return res.pipe(zlib.createBrotliDecompress());
  return res;
}

/**
 * Minimal fetch over the SOCKS proxy (Node's fetch cannot use SOCKS).
 * Returns { ok, status, url, headers: { get(name) }, text() }.
 */
export function proxyFetch(url, { method = 'GET', headers = {}, body, signal, proxy, maxRedirects = 5, timeoutMs = 90_000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, {
      method,
      agent: agentFor(proxy),
      headers: { 'Accept-Encoding': 'gzip, deflate, br', ...headers, ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}) },
      timeout: timeoutMs,
    }, (res) => {
      const status = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(status) && res.headers.location && maxRedirects > 0) {
        res.resume();
        const next = new URL(res.headers.location, u).toString();
        const keepBody = status === 307 || status === 308;
        proxyFetch(next, { method: keepBody ? method : 'GET', headers, body: keepBody ? body : undefined, signal, proxy, maxRedirects: maxRedirects - 1, timeoutMs })
          .then(resolve, reject);
        return;
      }
      const chunks = [];
      const stream = decode(res);
      stream.on('data', (c) => chunks.push(c));
      stream.on('error', reject);
      stream.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({
          ok: status >= 200 && status < 300,
          status,
          url,
          headers: { get: (name) => res.headers[String(name).toLowerCase()] ?? null },
          text: async () => text,
          json: async () => JSON.parse(text),
        });
      });
    });
    const onAbort = () => req.destroy(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    signal?.addEventListener('abort', onAbort, { once: true });
    req.on('timeout', () => req.destroy(new Error(`Délai dépassé via Tor (${Math.round(timeoutMs / 1000)} s)`)));
    req.on('error', (e) => {
      signal?.removeEventListener('abort', onAbort);
      if (/ECONNREFUSED|socks/i.test(e.message) && !/rejected|ttl|host unreachable/i.test(e.message)) {
        reject(new TorUnavailableError(`Connexion au proxy Tor impossible (${proxy}) : ${e.message}`));
      } else reject(e);
    });
    req.on('close', () => signal?.removeEventListener('abort', onAbort));
    if (body) req.write(body);
    req.end();
  });
}

/** Exit IP seen by the Tor Project's checker: confirms that traffic really goes through Tor. */
export async function checkTor(configured) {
  const proxy = await requireTor(configured);
  const res = await proxyFetch('https://check.torproject.org/api/ip', { proxy, timeoutMs: 60_000 });
  const data = await res.json();
  return { proxy, isTor: Boolean(data.IsTor), ip: data.IP };
}

/** Environment variables that make command-line tools (curl, git, wget…) use the proxy. */
export function proxyEnv(proxy) {
  const local = 'localhost,127.0.0.1,::1';
  return {
    ALL_PROXY: proxy, all_proxy: proxy,
    HTTPS_PROXY: proxy, https_proxy: proxy,
    HTTP_PROXY: proxy, http_proxy: proxy,
    NO_PROXY: local, no_proxy: local,
  };
}
