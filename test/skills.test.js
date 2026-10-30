import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Agent } from '../src/agent/agent.js';
import { parseSkill, loadSkills, skillDirs, mentionedSkills, matchingSkills, skillBlock } from '../src/agent/skills.js';

const skill = (name, extra = '') => `---\nname: ${name}\ndescription: d\n${extra}---\nDo ${name}.`;
const builtIn = () => loadSkills(skillDirs());

test('a skill file gives its metadata; without a valid name it is ignored', () => {
  const s = parseSkill('---\nname: a-b\ndescription: "Une ligne"\ntriggers: Écris ça, two words\nauto: false\nauthor: Me\nsource: https://x.y/z\nlicense: MIT\n---\nBody.\n');
  assert.deepEqual([s.name, s.description, s.triggers, s.auto, s.author, s.source, s.license, s.body], ['a-b', 'Une ligne', ['ecris ca', 'two words'], false, 'Me', 'https://x.y/z', 'MIT', 'Body.']);
  assert.equal(parseSkill('no frontmatter'), null);
  assert.equal(parseSkill('---\nname: Bad Name\n---\nx'), null);
});

test('a project skill replaces the same one of the user, and name/SKILL.md is read too', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lcx-skills-'));
  const user = path.join(root, 'user');
  await fs.mkdir(path.join(user, 'folder'), { recursive: true });
  await fs.mkdir(path.join(root, '.poney', 'skills'), { recursive: true });
  await fs.writeFile(path.join(user, 'mine.md'), skill('mine'));
  await fs.writeFile(path.join(user, 'folder', 'SKILL.md'), skill('folder'));
  await fs.writeFile(path.join(root, '.poney', 'skills', 'mine.md'), skill('mine', 'author: Project\n'));
  const all = loadSkills(skillDirs(root, user));
  assert.equal(all.find((s) => s.name === 'mine').author, 'Project');
  assert.equal(all.find((s) => s.name === 'mine').origin, 'project');
  assert.ok(all.some((s) => s.name === 'folder'));
  assert.ok(all.some((s) => s.name === 'grilling')); // (the built-in ones are still there)
});

test('/name is found alone in a message, not in a path or for an unknown skill', () => {
  const skills = [parseSkill(skill('grilling')), parseSkill(skill('research'))];
  const names = (t) => mentionedSkills(t, skills).map((s) => s.name);
  assert.deepEqual(names('/grilling mon plan'), ['grilling']);
  assert.deepEqual(names('fais /research, puis /grilling.'), ['research', 'grilling']);
  assert.deepEqual(names('lis src/grilling et /etc/research.md'), []);
  assert.deepEqual(names('/nothing here'), []);
});

test('a skill is chosen only on one of its exact phrases, whole words, without accents or case', () => {
  const on = parseSkill(skill('s', 'triggers: écris le readme\n'));
  const off = parseSkill(skill('t', 'triggers: écris le readme\nauto: false\n'));
  assert.deepEqual(matchingSkills('Peux-tu ECRIS LE README ?', [on, off]).map((s) => s.name), ['s']);
  assert.deepEqual(matchingSkills('ecris le readmes', [on]), []);
  assert.deepEqual(matchingSkills('le readme est faux', [on]), []);
});

test('the skills that come with the app: valid, short, sources given, none chosen for ordinary messages', () => {
  const all = builtIn();
  assert.equal(all.length, 11);
  for (const s of all) {
    assert.ok(s.description, s.name);
    assert.ok(s.body.length < 1700, `${s.name}: ${s.body.length}`);
    if (s.name === 'synthese') continue; // (written for Poney: nothing borrowed)
    assert.match(s.source, /^https:\/\/github\.com\//, s.name);
    assert.ok(s.author && s.license, s.name);
  }
  for (const text of ['corrige le bug du parser', 'lance les tests', 'What does this function do?', 'ajoute une option --days', 'Pourquoi ce fichier a changé ?']) {
    assert.deepEqual(matchingSkills(text, all), [], text);
  }
  assert.equal(all.find((s) => s.name === 'wait-what').auto, false);
  assert.deepEqual(matchingSkills('Fais-moi une synthèse de ces trois documents', all).map((s) => s.name), ['synthese']);
  assert.ok(skillBlock(all[0], 50).length < 120);
});

async function run(cwd, text, config = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      requests.push(JSON.parse(body));
      res.end(`${JSON.stringify({ message: { content: 'Done.' }, done: true, done_reason: 'stop' })}\n`);
    });
  });
  await new Promise((r) => server.listen(0, r));
  const agent = new Agent({ cwd, config: { baseUrl: `http://localhost:${server.address().port}`, model: 'm', shellEnabled: false, ...config } });
  const events = [];
  agent.on('event', (e) => events.push(e));
  for (const t of [text].flat()) await agent.send(t);
  server.close();
  return { requests, events };
}

test('the agent adds the skill to the message and says so, once while it is in view', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'lcx-skills-'));
  const { requests, events } = await run(cwd, ['/wait-what', 'fais une recherche sur Node', 'fais une recherche sur Deno']);
  const user = requests.at(-1).messages.filter((m) => m.role === 'user').map((m) => m.content);
  assert.match(user[0], /\(Skill "wait-what", for this request/);
  assert.match(user[1], /\(Skill "research"/);
  assert.doesNotMatch(user[2], /\(Skill/);
  const used = events.filter((e) => e.type === 'skill').map((e) => e.skills[0]);
  assert.deepEqual(used.map((s) => [s.name, s.auto]), [['wait-what', false], ['research', true]]);
  assert.equal(used[1].author, 'Matt Pocock');
});

test('automatic skills can be turned off; /name still works', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'lcx-skills-'));
  const { requests } = await run(cwd, ['fais une recherche sur Node', '/grilling mon plan'], { autoSkills: false });
  const user = requests.at(-1).messages.filter((m) => m.role === 'user').map((m) => m.content);
  assert.doesNotMatch(user[0], /\(Skill/);
  assert.match(user[1], /\(Skill "grilling"/);
});
