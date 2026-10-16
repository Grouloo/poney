// Web search without API keys: DuckDuckGo's HTML endpoint, or a SearXNG instance
// if one is configured (more reliable, self-hostable).

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

async function searchDuckDuckGo(query, signal) {
  const res = await fetch('https://html.duckduckgo.com/html/', {
    method: 'POST',
    headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ q: query }).toString(),
    signal,
  });
  if (!res.ok) throw new Error(`DuckDuckGo HTTP ${res.status}`);
  const html = await res.text();
  const results = [];
  const blockRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:class="result__snippet"[^>]*>([\s\S]*?)<\/a>|<\/div>\s*<\/div>)/g;
  let m;
  while ((m = blockRe.exec(html))) {
    let url = decodeEntities(m[1]);
    const redirect = url.match(/[?&]uddg=([^&]+)/);
    if (redirect) url = decodeURIComponent(redirect[1]);
    if (url.startsWith('//')) url = `https:${url}`;
    if (/duckduckgo\.com\/y\.js/.test(url)) continue; // ads
    results.push({ title: stripTags(m[2]), url, snippet: stripTags(m[3] || '') });
  }
  if (!results.length && /anomaly|captcha/i.test(html)) {
    throw new Error('DuckDuckGo refused the request (bot check). Configure a SearXNG URL in settings.');
  }
  return results;
}

async function searchSearxng(base, query, signal) {
  const url = `${base.replace(/\/+$/, '')}/search?format=json&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal });
  if (!res.ok) throw new Error(`SearXNG HTTP ${res.status}`);
  const data = await res.json();
  return (data.results || []).map((r) => ({ title: r.title || '', url: r.url, snippet: (r.content || '').slice(0, 300) }));
}

export async function webSearch(query, { searxngUrl, signal } = {}) {
  if (searxngUrl) return searchSearxng(searxngUrl, query, signal);
  return searchDuckDuckGo(query, signal);
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

export async function fetchUrl(url, { signal } = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,application/json,text/plain,*/*' }, signal, redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const type = res.headers.get('content-type') || '';
  const body = await res.text();
  if (/html/i.test(type) || /^\s*<(!doctype|html)/i.test(body)) return htmlToText(body);
  return body;
}
