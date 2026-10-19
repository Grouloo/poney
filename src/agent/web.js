// Web search without API keys: DuckDuckGo's HTML endpoint, or a SearXNG instance
// if one is configured (more reliable, self-hostable). With a Tor proxy, every
// request goes through Tor (DuckDuckGo through its onion service first).
import { proxyFetch, DDG_ONION } from './tor.js';

/** fetch, or the SOCKS one when a Tor proxy is given (never a silent clear-net fallback). */
const doFetch = (url, opts, proxy) => (proxy ? proxyFetch(url, { ...opts, proxy }) : fetch(url, opts));

const isLocalUrl = (u) => {
  try { return /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|.*\.local)$/i.test(new URL(u).hostname); } catch { return false; }
};

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#x27': "'", '#x2F': '/' };

export function decodeEntities(s) {
  return s.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+\d*);/gi, (m, e) => {
    if (ENTITIES[e] !== undefined) return ENTITIES[e];
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return m;
  });
}

const stripTags = (s) => decodeEntities(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

/** Results of a DuckDuckGo HTML page (clear-net or onion). */
export function parseDuckDuckGo(html) {
  // Titles and snippets are collected separately, then each snippet is attached
  // to the title before it (the markup between them varies across layouts).
  const titles = [...html.matchAll(/<a\b[^>]*class="result__a"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => ({
    at: m.index,
    href: (m[0].match(/href="([^"]+)"/) || [])[1] || '',
    title: m[1],
  }));
  const snippets = [...html.matchAll(/class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|td|div)>/g)].map((m) => ({ at: m.index, text: m[1] }));
  const results = [];
  titles.forEach((t, i) => {
    const next = titles[i + 1]?.at ?? Infinity;
    const snippet = snippets.find((sn) => sn.at > t.at && sn.at < next);
    let url = decodeEntities(t.href);
    const redirect = url.match(/[?&]uddg=([^&]+)/);
    if (redirect) url = decodeURIComponent(redirect[1]);
    if (url.startsWith('//')) url = `https:${url}`;
    if (!url || /duckduckgo\.com\/y\.js/.test(url)) return; // ads
    results.push({ title: stripTags(t.title), url, snippet: stripTags(snippet?.text || '') });
  });
  return results;
}

async function searchDuckDuckGo(query, signal, proxy) {
  // Through Tor: the onion service first (the clear-net endpoint often blocks Tor exits).
  const endpoints = proxy ? [`${DDG_ONION}/html/`, 'https://html.duckduckgo.com/html/'] : ['https://html.duckduckgo.com/html/'];
  let html = null;
  let lastError = null;
  for (const endpoint of endpoints) {
    try {
      const res = await doFetch(endpoint, {
        method: 'POST',
        headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ q: query }).toString(),
        signal,
      }, proxy);
      if (!res.ok) throw new Error(`DuckDuckGo HTTP ${res.status}`);
      html = await res.text();
      break;
    } catch (e) {
      if (signal?.aborted || e.name === 'TorUnavailableError') throw e;
      lastError = e;
    }
  }
  if (html === null) throw lastError;
  const results = parseDuckDuckGo(html);
  if (!results.length && /anomaly|captcha/i.test(html)) {
    throw new Error('DuckDuckGo refused the request (bot check). Configure a SearXNG URL in settings.');
  }
  return results;
}

async function searchSearxng(base, query, signal, proxy) {
  const url = `${base.replace(/\/+$/, '')}/search?format=json&q=${encodeURIComponent(query)}`;
  // A local instance is reached directly (it is on this machine).
  const res = await doFetch(url, { headers: { 'User-Agent': UA }, signal }, isLocalUrl(base) ? null : proxy);
  if (!res.ok) throw new Error(`SearXNG HTTP ${res.status}`);
  const data = await res.json();
  return (data.results || []).map((r) => ({ title: r.title || '', url: r.url, snippet: (r.content || '').slice(0, 300) }));
}

export async function webSearch(query, { searxngUrl, signal, proxy } = {}) {
  if (searxngUrl) return searchSearxng(searxngUrl, query, signal, proxy);
  return searchDuckDuckGo(query, signal, proxy);
}

export function htmlToText(html) {
  let s = html;
  const title = (s.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
  const main = s.match(/<(main|article)[\s\S]*?<\/\1>/i);
  if (main && main[0].length > 500) s = main[0];
  s = s
    .replace(/<(script|style|noscript|svg|nav|footer|header|aside|form|iframe)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, c) => `\n\`\`\`\n${c.replace(/<[^>]+>/g, '')}\n\`\`\`\n`)
    .replace(/<h([1-6])[^>]*>/gi, (_, n) => `\n\n${'#'.repeat(+n)} `)
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<(br|\/p|\/div|\/h[1-6]|\/li|\/tr|\/section|\/table)[^>]*>/gi, '\n')
    .replace(/<code[^>]*>/gi, '`').replace(/<\/code>/gi, '`')
    .replace(/<[^>]+>/g, '');
  s = decodeEntities(s).replace(/[ \t]+/g, ' ').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return title ? `# ${stripTags(title)}\n\n${s}` : s;
}

export async function fetchUrl(url, { signal, proxy } = {}) {
  const res = await doFetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,application/json,text/plain,*/*' }, signal, redirect: 'follow' }, proxy);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const type = res.headers.get('content-type') || '';
  const body = await res.text();
  if (/html/i.test(type) || /^\s*<(!doctype|html)/i.test(body)) return htmlToText(body);
  return body;
}
