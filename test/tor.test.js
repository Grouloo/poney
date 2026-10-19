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
