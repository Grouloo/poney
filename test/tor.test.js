import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { normalizeProxy, proxyEnv, DDG_ONION } from '../src/agent/tor.js';
import { fetchUrl, webSearch } from '../src/agent/web.js';
import { executeAction } from '../src/agent/tools.js';

/**
 * Minimal SOCKS5 proxy (no auth, CONNECT): records the requested host:port and
 * forwards every connection to `target` (a local port) — or refuses it.
 */
function fakeSocks(target) {
  const seen = [];
  const server = net.createServer((client) => {
    client.once('data', () => {
      client.write(Buffer.from([5, 0])); // no auth
      client.once('data', (req) => {
        const atyp = req[3];
        let host;
        let off;
        if (atyp === 3) { const len = req[4]; host = req.subarray(5, 5 + len).toString(); off = 5 + len; }
        else if (atyp === 1) { host = [...req.subarray(4, 8)].join('.'); off = 8; }
        else { host = 'ipv6'; off = 20; }
        const port = req.readUInt16BE(off);
        seen.push(`${host}:${port}`);
        if (!target) { client.end(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0])); return; } // connection refused
        const up = net.connect(target, '127.0.0.1', () => {
          client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
          client.pipe(up).pipe(client);
        });
        up.on('error', () => client.destroy());
      });
    });
    client.on('error', () => {});
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, proxy: `socks5h://127.0.0.1:${server.address().port}` })));
}

function site(html) {
  const server = http.createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end(html); });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

test('proxy addresses are normalized to socks5h (DNS through Tor)', () => {
  assert.equal(normalizeProxy('127.0.0.1:9150'), 'socks5h://127.0.0.1:9150');
  assert.equal(normalizeProxy('socks5://10.0.0.2:9050'), 'socks5h://10.0.0.2:9050');
  assert.equal(normalizeProxy(''), null);
  assert.equal(proxyEnv('socks5h://127.0.0.1:9050').ALL_PROXY, 'socks5h://127.0.0.1:9050');
  assert.match(proxyEnv('x').NO_PROXY, /localhost/);
});

test('page reading goes through the proxy, the host name is resolved by the proxy', async () => {
  const s = await site('<html><head><title>Hidden</title></head><body><p>Through the tunnel</p></body></html>');
  const socks = await fakeSocks(s.port);
  const text = await fetchUrl('http://some-site.example/page', { proxy: socks.proxy });
  socks.server.close(); s.server.close();
  assert.match(text, /Through the tunnel/);
  assert.deepEqual(socks.seen, ['some-site.example:80'], 'no local DNS resolution: the name was sent to the proxy');
});

test('search through Tor tries the DuckDuckGo onion first, then clear-net DuckDuckGo, both via the proxy', async () => {
  const socks = await fakeSocks(null); // refuses every connection
  await assert.rejects(webSearch('node lts', { proxy: socks.proxy }));
  socks.server.close();
  assert.deepEqual(socks.seen, [`${new URL(DDG_ONION).hostname}:443`, 'html.duckduckgo.com:443']);
});

test('fail closed: Tor enabled but unreachable, the request is refused and never sent', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'lcx-tor-'));
  const closed = await new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const config = { torEnabled: true, torProxy: `127.0.0.1:${closed}` };
  for (const action of [{ tool: 'web_search', args: { query: 'x' } }, { tool: 'fetch', args: { url: 'https://example.com' } }]) {
    const r = await executeAction(action, { cwd, config, maxResultChars: 5000 });
    assert.equal(r.ok, false);
    assert.match(r.output, /Tor est activé mais injoignable/);
  }
});

test('terminal commands get the proxy variables only when asked', async () => {
  const s = await site('x');
  const socks = await fakeSocks(s.port);
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'lcx-tor-'));
  const run = (config) => executeAction({ tool: 'run', args: { command: 'echo "proxy=$ALL_PROXY"' } }, { cwd, config: { commandTimeout: 10, ...config }, maxResultChars: 5000 });
  const withTor = await run({ torEnabled: true, torShell: true, torProxy: socks.proxy });
  const without = await run({ torEnabled: true, torShell: false, torProxy: socks.proxy });
  socks.server.close(); s.server.close();
  assert.match(withTor.output, new RegExp(`proxy=${socks.proxy}`));
  assert.equal(withTor.meta.tor, true);
  assert.match(without.output, /^proxy=$/m);
});

test('DuckDuckGo results keep their snippets whatever the markup between title and snippet', async () => {
  const { parseDuckDuckGo } = await import('../src/agent/web.js');
  const html = `<div class="result"><h2><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2Fen">Node.js</a></h2></div></div>
    <div class="result__extras"></div></div>
    <a class="result__snippet" href="https://nodejs.org/en"><b>Node.js</b> is a JavaScript runtime</a>
    <div class="result"><h2><a class="result__a" href="https://example.com/x">Second</a></h2></div></div>`;
  assert.deepEqual(parseDuckDuckGo(html).map((x) => [x.title, x.url, x.snippet]), [
    ['Node.js', 'https://nodejs.org/en', 'Node.js is a JavaScript runtime'],
    ['Second', 'https://example.com/x', ''],
  ]);
});

// ---------- connection status ----------
import { torControlStatus, torStatus, closeTorControls } from '../src/agent/tor.js';
import { afterEach } from 'node:test';
afterEach(() => closeTorControls()); // persistent control connections would keep the test process alive

/** Fake Tor control port: cookie authentication, then the given bootstrap phase. */
async function fakeControl(phase, { circuit = true } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lcx-ctl-'));
  const cookie = Buffer.alloc(32, 7);
  const cookieFile = path.join(dir, 'control_auth_cookie');
  await fs.writeFile(cookieFile, cookie);
  const auths = [];
  const server = net.createServer((c) => {
    c.on('data', (d) => {
      const line = d.toString().trim();
      if (line.startsWith('PROTOCOLINFO')) c.write(`250-PROTOCOLINFO 1\r\n250-AUTH METHODS=COOKIE,SAFECOOKIE COOKIEFILE="${cookieFile}"\r\n250-VERSION Tor="0.4.9"\r\n250 OK\r\n`);
      else if (line.startsWith('AUTHENTICATE')) { auths.push(line.split(' ')[1]); c.write(line.split(' ')[1] === cookie.toString('hex') ? '250 OK\r\n' : '515 Authentication failed\r\n'); }
      else if (line.startsWith('GETINFO')) c.write(`250-status/bootstrap-phase=${phase}\r\n250-status/circuit-established=${circuit ? 1 : 0}\r\n250 OK\r\n`);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, port: server.address().port, auths, cookie };
}

test('control port: cookie authentication and bootstrap progress', async () => {
  const ctl = await fakeControl('NOTICE BOOTSTRAP PROGRESS=45 TAG=loading_descriptors SUMMARY="Loading relay descriptors"', { circuit: false });
  const s = await torControlStatus(ctl.port);
  closeTorControls();
  ctl.server.close();
  assert.deepEqual(s, { progress: 45, summary: 'Loading relay descriptors', warning: null, circuit: false });
  assert.deepEqual(ctl.auths, [ctl.cookie.toString('hex')]);
});

test('status: off, connecting, stuck, connected', async () => {
  // Tor not running.
  const closed = await new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  assert.equal((await torStatus({ torEnabled: true, torProxy: `127.0.0.1:${closed}` })).state, 'off');
  assert.equal((await torStatus({ torEnabled: false })).state, 'disabled');

  // A SOCKS port with its control port right after it (as Tor does: 9050/9051).
  const pair = async (phase, circuit) => {
    for (let tries = 0; tries < 20; tries++) {
      const ctl = await fakeControl(phase, { circuit });
      const socks = net.createServer();
      const ok = await new Promise((r) => { socks.once('error', () => r(false)); socks.listen(ctl.port - 1, '127.0.0.1', () => r(true)); });
      if (ok) return { proxy: `127.0.0.1:${ctl.port - 1}`, close: () => { closeTorControls(); ctl.server.close(); socks.close(); } };
      ctl.server.close();
    }
    throw new Error('no free port pair');
  };
  let p = await pair('NOTICE BOOTSTRAP PROGRESS=62 TAG=loading_descriptors SUMMARY="Loading relay descriptors"', false);
  let s = await torStatus({ torEnabled: true, torProxy: p.proxy });
  p.close();
  assert.deepEqual([s.state, s.progress], ['bootstrapping', 62]);

  p = await pair('WARN BOOTSTRAP PROGRESS=10 TAG=conn_done SUMMARY="Connected to a relay" WARNING="Connection timed out"', false);
  s = await torStatus({ torEnabled: true, torProxy: p.proxy });
  p.close();
  assert.equal(s.state, 'stuck');
  assert.match(s.detail, /bloqué à 10 %.*Connection timed out/);

  p = await pair('NOTICE BOOTSTRAP PROGRESS=100 TAG=done SUMMARY="Done"', true);
  s = await torStatus({ torEnabled: true, torProxy: p.proxy });
  p.close();
  assert.equal(s.state, 'connected');
});

test('100 % without an open circuit: reconnecting for a while, then checked by a test connection', async () => {
  // Control port says 100 % but no circuit; the SOCKS port refuses connections -> no-circuit, not "bootstrapping".
  for (let tries = 0; tries < 20; tries++) {
    const ctl = await fakeControl('NOTICE BOOTSTRAP PROGRESS=100 TAG=done SUMMARY="Done"', { circuit: false });
    const socks = await fakeSocks(null);
    socks.server.close();
    const s2 = net.createServer((c) => { c.once('data', () => { c.write(Buffer.from([5, 0])); c.once('data', () => c.end(Buffer.from([5, 1, 0, 1, 0, 0, 0, 0, 0, 0]))); }); });
    const ok = await new Promise((r) => { s2.once('error', () => r(false)); s2.listen(ctl.port - 1, '127.0.0.1', () => r(true)); });
    if (!ok) { ctl.server.close(); continue; }
    const proxy = `127.0.0.1:${ctl.port - 1}`;
    // Within the grace period after losing its circuits (e.g. sleep): reconnecting, not an error.
    const first = await torStatus({ torEnabled: true, torProxy: proxy }, { probeEveryMs: 0 });
    // Past it, a failing test connection means no circuit.
    const later = await torStatus({ torEnabled: true, torProxy: proxy }, { probeEveryMs: 0, reconnectGraceMs: 0 });
    closeTorControls();
    ctl.server.close(); s2.close();
    assert.equal(first.state, 'reconnecting');
    assert.equal(later.state, 'no-circuit');
    return;
  }
  throw new Error('no free port pair');
});
