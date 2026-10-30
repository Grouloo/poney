// Skills: instructions kept out of the system prompt, added to a message only
// when it needs them. The app chooses them (small models forget to, and a list
// would cost tokens at each message): the user names one with /name, or the
// message contains one of its exact trigger phrases. The strict match is on
// purpose: a skill missed costs nothing, a wrong one misleads a small context.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BUILT_IN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills');
const NAME = /^[a-z0-9][a-z0-9-]*$/;
const fold = (s) => String(s).normalize('NFD').replace(/\p{M}/gu, '').replace(/[’]/g, "'").toLowerCase();

/** A skill from its file (frontmatter, then instructions), or null when it has no valid name. */
export function parseSkill(text, origin = 'built-in') {
  const m = String(text).match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return null;
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].trim().replace(/^(["'])(.*)\1$/, '$2');
  }
  if (!NAME.test(meta.name ?? '')) return null;
  return {
    name: meta.name,
    description: meta.description ?? '',
    triggers: (meta.triggers ?? '').split(',').map((t) => fold(t).trim()).filter(Boolean),
    auto: meta.auto !== 'false',
    author: meta.author ?? '',
    source: meta.source ?? '',
    license: meta.license ?? '',
    adapted: meta.adapted ?? '',
    origin,
    body: m[2].trim(),
  };
}

/** The folders of skills, the last ones first in priority: built in, the user's, the project's. */
export const skillDirs = (cwd, userDir) => [
  { dir: BUILT_IN, origin: 'built-in' },
  ...(userDir ? [{ dir: userDir, origin: 'user' }] : []),
  ...(cwd ? [{ dir: path.join(cwd, '.poney', 'skills'), origin: 'project' }] : []),
];

/** Every skill of these folders (name.md, or name/SKILL.md), sorted by name. */
export function loadSkills(dirs) {
  const skills = new Map();
  for (const { dir, origin } of dirs) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const file = e.isDirectory() ? path.join(dir, e.name, 'SKILL.md') : e.name.endsWith('.md') ? path.join(dir, e.name) : null;
      if (!file) continue;
      try {
        const skill = parseSkill(fs.readFileSync(file, 'utf8'), origin);
        if (skill) skills.set(skill.name, skill);
      } catch {}
    }
  }
  return [...skills.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The skills named with /name in a message (not a path: /name stands alone). */
export function mentionedSkills(text, skills) {
  const names = [...String(text).matchAll(/(?:^|\s)\/([a-z0-9][a-z0-9-]*)(?=$|[\s.,:;!?)])/g)].map((m) => m[1]);
  return [...new Set(names)].map((n) => skills.find((s) => s.name === n)).filter(Boolean);
}

/** The skills whose exact trigger phrases are in a message, the best first. */
export function matchingSkills(text, skills, { max = 1 } = {}) {
  const words = fold(text);
  const hits = (t) => {
    const i = words.indexOf(t);
    const edge = (c) => c === undefined || !/[\p{L}\p{N}]/u.test(c);
    return i >= 0 && edge(words[i - 1]) && edge(words[i + t.length]);
  };
  return skills
    .filter((s) => s.auto)
    .map((s) => ({ s, score: s.triggers.filter(hits).length }))
    .filter((x) => x.score)
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map((x) => x.s);
}

/** A skill as added to the user's message. */
export const skillBlock = (skill, maxChars) => `(Skill "${skill.name}", for this request. Follow it:\n${skill.body.length > maxChars ? `${skill.body.slice(0, maxChars)}…` : skill.body}\n)`;
