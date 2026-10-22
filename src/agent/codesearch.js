// <search>keywords</search>: a ranked search over the project's files, like a web
// search: the most relevant files first, each with its best lines (and their
// numbers), so that the agent reads only those parts instead of every file.
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const MAX_FILE = 1_000_000;
const MAX_FILES = 20_000;
const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'where', 'what', 'how', 'les', 'des', 'une', 'pour', 'avec', 'dans', 'que', 'qui', 'est', 'sur', 'par', 'comment', 'code', 'file', 'fichier']);
const DEFINITION = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:def|class|function|func|fn|const|let|var|interface|type|struct|enum|impl|module|public|private|protected|static)\b|^\s*[\w.]+\s*[:=]\s*(?:async\s+)?(?:function|\(|lambda)|^#{1,6}\s/;

const fold = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/** Words of a text, identifiers split the code way: loadConfig, load_config, LOAD-CONFIG → load, config. */
export function tokens(text) {
  return fold(String(text).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')).match(/[\p{L}\p{N}]+/gu) || [];
}

/** A search word matches a word of the text: the same, or a longer form of it (compact → compaction). */
const matches = (word, term) => word === term || (word.startsWith(term) && (term.length >= 5 || word.length - term.length <= 2));

/** Search words: identifiers and words of 3 letters or more; "a b" phrases kept whole. */
export function codeTerms(query) {
  const terms = [];
  const rest = String(query ?? '').replace(/"([^"]+)"/g, (_, p) => { terms.push(fold(p.trim())); return ' '; });
  for (const t of tokens(rest)) if (t.length >= 3 && !STOP.has(t)) terms.push(t);
  return [...new Set(terms)];
}

const run = (cmd, args, cwd) => new Promise((resolve) => {
  execFile(cmd, args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (err, out) => resolve(err ? null : out));
});

/** The project's files under `dir` (relative to cwd, with "/"): git's list when it is a repository (respects .gitignore). */
export async function projectFiles(cwd, dir = '.', ignoredDirs = new Set()) {
  const base = path.resolve(cwd, dir);
  const git = await run('git', ['ls-files', '-co', '--exclude-standard', '--', dir], cwd);
  if (git !== null && git.trim()) return git.split('\n').filter(Boolean).slice(0, MAX_FILES);
  const out = [];
  async function walk(p) {
    if (out.length >= MAX_FILES) return;
    let entries;
    try { entries = await fs.readdir(p, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(p, e.name);
      if (e.isDirectory()) { if (!ignoredDirs.has(e.name)) await walk(full); }
      else if (e.isFile()) out.push(path.relative(cwd, full).split(path.sep).join('/'));
    }
  }
  await walk(base);
  return out;
}

// File contents, kept while their modification time does not change (searches come in series).
const cache = new Map();
async function readText(abs) {
  let st;
  try { st = await fs.stat(abs); } catch { return null; }
  if (!st.isFile() || st.size > MAX_FILE) return null;
  const hit = cache.get(abs);
  if (hit && hit.mtime === st.mtimeMs) return hit;
  let text;
  try { text = await fs.readFile(abs, 'utf8'); } catch { return null; }
  if (text.includes('\u0000')) text = null; // binary
  if (cache.size > 30_000) cache.clear();
  let words = null;
  if (text !== null) {
    words = new Map();
    for (const w of tokens(text)) words.set(w, (words.get(w) || 0) + 1);
  }
  const entry = { mtime: st.mtimeMs, text, words };
  cache.set(abs, entry);
  return entry;
}

/** Occurrences of a search word (a phrase: in the folded text; a word: among the words). */
function count(entry, term) {
  if (term.includes(' ')) {
    const low = entry.low ??= fold(entry.text);
    let n = 0;
    for (let i = low.indexOf(term); i >= 0 && n < 200; i = low.indexOf(term, i + term.length)) n++;
    return n;
  }
  let n = 0;
  for (const [w, k] of entry.words) if (matches(w, term)) n += k;
  return n;
}

const lineHas = (line, term) => (term.includes(' ') ? fold(line).includes(term) : tokens(line).some((w) => matches(w, term)));

/**
 * Ranked search. Files score by how many of the words they contain (rare words
 * weigh more), by the words in their path, and by definitions (def/class/
 * function… or a heading) that contain a word. Returns the result text.
 */
export async function rankedSearch(cwd, dir, query, { ignoredDirs, maxChars = 3000, maxFiles = 8, linesPerFile = 3 } = {}) {
  const terms = codeTerms(query);
  if (!terms.length) return { output: 'Give a few keywords, like <search>load config</search>.', count: 0 };
  const files = await projectFiles(cwd, dir, ignoredDirs);
  const found = [];
  for (const rel of files) {
    const entry = await readText(path.join(cwd, rel));
    if (!entry?.text) continue;
    const counts = terms.map((t) => count(entry, t));
    const pathWords = tokens(rel);
    const inPath = terms.map((t) => (t.includes(' ') ? fold(rel).includes(t) : pathWords.some((w) => matches(w, t))));
    if (!counts.some(Boolean) && !inPath.some(Boolean)) continue;
    found.push({ rel, text: entry.text, counts, inPath });
  }
  if (!found.length) return { output: `No file of the ${files.length} searched contains: ${terms.join(', ')}. Try other words (names of functions, classes, messages).`, count: 0 };
  // Rarity of each word among the matching files.
  const idf = terms.map((_, k) => Math.log(1 + found.length / (1 + found.filter((f) => f.counts[k] || f.inPath[k]).length)) + 0.2);
  for (const f of found) {
    const lines = f.text.split('\n');
    f.best = [];
    let defs = 0;
    let defines = false; // a definition line with all the words: where the thing is defined
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].length > 2000) continue; // (minified code)
      const hits = terms.reduce((s, t, k) => s + (f.counts[k] && lineHas(lines[i], t) ? idf[k] : 0), 0);
      if (!hits) continue;
      const def = DEFINITION.test(lines[i]);
      if (def) defs += hits;
      if (def && terms.every((t, k) => f.counts[k] && lineHas(lines[i], t))) defines = true;
      f.best.push({ n: i + 1, line: lines[i].trim().slice(0, 160), score: hits + (def ? 1.5 : 0) });
    }
    f.best = f.best.sort((a, b) => b.score - a.score).slice(0, linesPerFile).sort((a, b) => a.n - b.n);
    f.score = terms.reduce((s, _, k) => s + (f.counts[k] ? idf[k] * (1 + Math.log(f.counts[k])) : 0) + (f.inPath[k] ? 2 * idf[k] : 0), 0) + Math.min(defs, 6) + (defines ? 3 : 0);
    if (/(^|\/)(tests?|spec|__tests__)\/|(^|[._-])(test|spec)[._-]/i.test(f.rel)) f.score *= 0.7; // tests: after the code they test
    f.total = f.counts.reduce((a, b) => a + b, 0);
  }
  const ranked = found.sort((a, b) => b.score - a.score).slice(0, maxFiles);
  let out = `${found.length} file(s) of ${files.length} match ${terms.map((t) => `"${t}"`).join(' ')}; the most relevant:`;
  for (const f of ranked) {
    let piece = `\n${f.rel} (${f.total} match${f.total > 1 ? 'es' : ''})`;
    for (const b of f.best) piece += `\n  ${b.n}: ${b.line}`;
    if (out.length + piece.length > maxChars) break;
    out += piece;
  }
  out += '\nRead only the relevant parts: <read path="..." start="..." end="..." />.';
  return { output: out, count: found.length };
}
