// Requests through Tor (SOCKS5 proxy of the tor daemon or of Tor Browser).
//
// "socks5h": host names are resolved by Tor, not by the local DNS, so the sites
// visited do not leak through DNS. Fail closed: when Tor is enabled but cannot
// be reached, the request is refused, never sent in the clear.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import zlib from 'node:zlib';
import fs from 'node:fs/promises';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { SocksClient } from 'socks';

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
      if (/proxy connection timed out|general SOCKS server failure|TTL expired/i.test(e.message)) {
        // The proxy answers but Tor has no circuit (often: network blocking Tor relays).
        reject(new TorUnavailableError(`Tor ne parvient pas à établir de circuit (${proxy}) : le réseau bloque peut-être Tor ; des ponts (bridges) peuvent être nécessaires. La requête n'a pas été envoyée en clair.`));
      } else if (/ECONNREFUSED|socks/i.test(e.message) && !/rejected|host unreachable/i.test(e.message)) {
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

// ---------- connection status ----------

/**
 * Talks to Tor's control port (local only): authenticates with the cookie file
 * Tor names in PROTOCOLINFO, then asks for the bootstrap phase. Null if not available.
 */
export function torControlStatus(port, { timeoutMs = 3000 } = {}) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let buf = '';
    let step = 0;
    const done = (v) => { socket.destroy(); resolve(v); };
    socket.setTimeout(timeoutMs, () => done(null));
    socket.on('error', () => done(null));
    socket.on('connect', () => socket.write('PROTOCOLINFO 1\r\n'));
    socket.on('data', async (d) => {
      buf += d.toString();
      if (!/^\d{3} .*\r\n$/m.test(buf)) return; // wait for the final line of the reply
      const reply = buf;
      buf = '';
      if (!reply.startsWith('250')) return done(null);
      if (step === 0) {
        step = 1;
        const methods = (reply.match(/METHODS=(\S+)/) || [])[1] || '';
        const cookieFile = (reply.match(/COOKIEFILE="((?:[^"\\]|\\.)*)"/) || [])[1];
        let auth = '';
        if (/COOKIE/.test(methods) && cookieFile) {
          try { auth = (await fs.readFile(cookieFile.replace(/\\(.)/g, '$1'))).toString('hex'); } catch { return done(null); }
        } else if (!/NULL/.test(methods)) return done(null); // password only: not supported
        socket.write(`AUTHENTICATE ${auth}\r\n`);
      } else if (step === 1) {
        step = 2;
        socket.write('GETINFO status/bootstrap-phase status/circuit-established\r\n');
      } else {
        const phase = (reply.match(/status\/bootstrap-phase=(.*)/) || [])[1] || '';
        done({
          progress: Number((phase.match(/PROGRESS=(\d+)/) || [])[1] ?? 0),
          summary: (phase.match(/SUMMARY="([^"]*)"/) || [])[1] || '',
          warning: /^WARN/.test(phase) ? ((phase.match(/WARNING="([^"]*)"/) || [])[1] || 'problème de connexion') : null,
          circuit: /status\/circuit-established=1/.test(reply),
        });
      }
    });
  });
}

/** Opens (then closes) a connection through Tor: true if a circuit works. */
export async function socksProbe(proxy, { host = 'check.torproject.org', port = 443, timeoutMs = 20_000 } = {}) {
  const u = new URL(proxy);
  try {
    const { socket } = await SocksClient.createConnection({
      proxy: { host: u.hostname, port: Number(u.port), type: 5 },
      command: 'connect',
      destination: { host, port },
      timeout: timeoutMs,
    });
    socket.destroy();
    return true;
  } catch {
    return false;
  }
}

let probeCache = null; // { proxy, ok, at }: the probe opens a real connection, keep it rare

/**
 * State of the Tor connection, for the UI:
 * { state: 'disabled' | 'off' | 'bootstrapping' | 'stuck' | 'connected' | 'no-circuit', proxy?, progress?, detail }
 */
export async function torStatus(config = {}, { probeEveryMs = 30_000 } = {}) {
  if (!config.torEnabled) return { state: 'disabled', detail: 'Tor désactivé' };
  const proxy = await findTorProxy(config.torProxy);
  if (!proxy) {
    const where = normalizeProxy(config.torProxy) || `127.0.0.1:${TOR_DEFAULT_PORTS.join(' / ')}`;
    return { state: 'off', detail: `Tor ne tourne pas (${where}) : les requêtes web sont refusées` };
  }
  const socksPort = Number(new URL(proxy).port);
  const control = await torControlStatus(socksPort + 1); // convention: 9050 -> 9051, 9150 -> 9151
  if (control) {
    if (control.progress >= 100 && control.circuit) return { state: 'connected', proxy, progress: 100, detail: 'Tor connecté' };
    if (control.warning) return { state: 'stuck', proxy, progress: control.progress, detail: `Tor bloqué à ${control.progress} % (${control.summary}) : ${control.warning}` };
    return { state: 'bootstrapping', proxy, progress: control.progress, detail: `Tor se connecte : ${control.progress} % (${control.summary})` };
  }
  if (!probeCache || probeCache.proxy !== proxy || Date.now() - probeCache.at > probeEveryMs) {
    probeCache = { proxy, ok: await socksProbe(proxy), at: Date.now() };
  }
  return probeCache.ok
    ? { state: 'connected', proxy, detail: 'Tor connecté (vérifié par une connexion de test)' }
    : { state: 'no-circuit', proxy, detail: 'Tor tourne mais n’établit pas de circuit (réseau bloqué ? ponts ?) : les requêtes web sont refusées' };
}
