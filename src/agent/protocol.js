// Text-based tool protocol designed for small models.
//
// Instead of JSON function calling (small models break JSON escaping as soon as
// the payload is code), actions are plain tags. Short arguments are attributes,
// long ones (file content, commands) are the tag body, so nothing needs escaping:
//
//   <write path="app.py">
//   print("hi")
//   </write>
//   <run>python3 app.py</run>
//
// The parser is deliberately forgiving: arguments may also be given as child
// tags (<path>app.py</path>), quotes are optional, code fences inside bodies are
// stripped, and a missing closing tag is tolerated for body-less tools.

export const TOOLS = {
  list: { args: ['path', 'depth'], bodyArg: 'path', needsBody: false, observes: true },
  read: { args: ['path', 'start', 'end'], bodyArg: 'path', needsBody: false, observes: true },
  search: { args: ['pattern', 'path'], bodyArg: 'pattern', needsBody: false, observes: true },
  write: { args: ['path'], bodyArg: 'content', needsBody: true, observes: false },
  edit: { args: ['path'], bodyArg: 'body', needsBody: true, observes: false },
  run: { args: ['timeout'], bodyArg: 'command', needsBody: true, observes: true },
  web_search: { args: ['query'], bodyArg: 'query', needsBody: false, observes: true },
  fetch: { args: ['url'], bodyArg: 'url', needsBody: false, observes: true },
  // Delegates a task to a sub-agent. Consecutive <agent> tags run at the same time.
  agent: { args: ['title'], bodyArg: 'task', needsBody: true, observes: true },
};

// Common aliases small models reach for. Mapped to canonical names.
const ALIASES = {
  ls: 'list', list_files: 'list', list_dir: 'list',
  read_file: 'read', cat: 'read', open: 'read', view: 'read',
  grep: 'search', find: 'search',
  write_file: 'write', create: 'write', create_file: 'write',
  edit_file: 'edit', replace: 'edit', patch: 'edit',
  bash: 'run', shell: 'run', exec: 'run', execute: 'run', command: 'run', terminal: 'run',
  search_web: 'web_search', websearch: 'web_search', google: 'web_search',
  fetch_url: 'fetch', browse: 'fetch', open_url: 'fetch',
  subagent: 'agent', sub_agent: 'agent', delegate: 'agent', spawn_agent: 'agent', task: 'agent',
};

const ALL_NAMES = [...Object.keys(TOOLS), ...Object.keys(ALIASES)];
// Longest first so "web_search" wins over "search".
const NAME_RE = ALL_NAMES.sort((a, b) => b.length - a.length).join('|');
const OPEN_RE = new RegExp(`<(${NAME_RE})(\\s[^<>]*?)?\\s*(/?)>`, 'g');

/**
 * The same tools in the standard function-calling format. Declared to servers
 * whose model supports native tool calls (LM Studio, "tool_use"): Gemma uses
 * its native format anyway, and without the declaration LM Studio holds those
 * calls back until they end, and drops them if cut (nothing visible for minutes).
 */
export function toolSchemas(config = {}) {
  const fn = (name, description, props, required) => ({
    type: 'function',
    function: {
      name,
      description,
      parameters: { type: 'object', properties: Object.fromEntries(Object.entries(props).map(([k, d]) => [k, { type: 'string', description: d }])), required },
    },
  });
  const all = [
    fn('list', 'List files in a folder', { path: 'folder, default "."' }, []),
    fn('read', 'Read a file (with line numbers)', { path: 'file path', start: 'first line', end: 'last line' }, ['path']),
    fn('search', 'Search text in files', { pattern: 'regex', path: 'folder' }, ['pattern']),
    fn('write', 'Create or overwrite a whole file', { path: 'file path', content: 'full file content' }, ['path', 'content']),
    fn('edit', 'Replace exact existing lines in a file', { path: 'file path', old: 'exact existing lines', new: 'replacement lines' }, ['path', 'old', 'new']),
    fn('run', 'Run a shell command (scripts, tests, installs)', { command: 'shell command' }, ['command']),
    fn('web_search', 'Search the internet', { query: 'search query' }, ['query']),
    fn('fetch', 'Read a web page', { url: 'full URL' }, ['url']),
    {
      type: 'function',
      function: {
        name: 'agent',
        description: 'Delegate independent tasks to sub-agents. Put ALL the tasks to run at the same time in one call (one item each).',
        parameters: {
          type: 'object',
          properties: {
            tasks: {
              type: 'array',
              description: 'one item per sub-agent; they all run at the same time',
              items: {
                type: 'object',
                properties: { title: { type: 'string', description: 'short name' }, task: { type: 'string', description: 'complete task with all the context it needs' } },
                required: ['title', 'task'],
              },
            },
          },
          required: ['tasks'],
        },
      },
    },
  ];
  return all.filter((t) => isToolEnabled(t.function.name, config));
}

/** Tools that can be switched off in the settings, and the config flag for each. */
export const TOOL_FLAGS = { run: 'shellEnabled', web_search: 'webEnabled', fetch: 'webEnabled', agent: 'subagentsEnabled' };

export function isToolEnabled(tool, config) {
  const flag = TOOL_FLAGS[tool];
  return !flag || config[flag] !== false;
}

export function buildSystemPrompt({ cwd, platform, projectNotes, testCommand, shell = true, web = true, subagents = false, subagentRole = false }) {
  const notes = projectNotes ? `\nPROJECT NOTES (from the repo):\n${projectNotes}\n` : '';
  const testLine = testCommand && shell
    ? `\nThe project test command is: ${testCommand}\nIt is run automatically when you finish; make it pass.`
    : '';

  const tools = [
    '<list path="." />                       list files',
    '<read path="a.py" start="1" end="200" />  read a file (with line numbers)',
    '<search pattern="regex" path="." />     search text in files',
    '<write path="a.py">\nfull file content\n</write>                                create or overwrite a file',
    '<edit path="a.py">\n<old>exact existing lines</old>\n<new>replacement lines</new>\n</edit>                                 change part of a file',
  ];
  if (shell) tools.push('<run>command</run>                      run a shell command (scripts, tests, installs)');
  if (web) {
    tools.push('<web_search>query</web_search>          search the internet');
    tools.push('<fetch>https://url</fetch>              read a web page');
  }
  if (subagents) {
    tools.push('<agent title="short name">\ncomplete task, with all the context it needs\n</agent>                                delegate an independent task to a sub-agent');
  }

  const rules = ['Read the files you need before changing them. Never guess file contents.'];
  if (shell) {
    rules.push('ALWAYS TEST. After changing code, run it or its tests with <run>. If it fails, fix the code (not the test, unless the test is wrong) and run again.');
  } else {
    rules.push('You CANNOT run commands. After changing code, re-read it carefully to check it. Tell the user how to test it.');
  }
  rules.push('Work in small steps, then wait for the results. Never invent results.');
  rules.push('Use <write> for new files, <edit> to change existing files. Never <write> over a file you have not read.');
  if (shell) rules.push('Commands time out; do not start servers that never stop.');
  if (!web) rules.push('You have no internet access.');
  if (subagents) {
    rules.push('Sub-agents: put ALL the independent tasks in ONE message (one <agent> tag each, one after the other): they run at the same time, then you get all the reports. Do not launch them one by one. Use them only for tasks that touch different files. A sub-agent cannot see this conversation: write in the task everything it needs (files, goal, constraints).');
  }
  rules.push(subagentRole
    ? `When your task is finished${shell ? ' and tested' : ''}, answer WITHOUT any tool tag: a short report for the main agent (what you did, files changed, test results, problems left).`
    : `When the task is finished${shell ? ' and tested' : ''}, answer WITHOUT any tool tag: a short summary for the user, in the user's language.`);

  const example = shell
    ? `<write path="hello.py">
print("hi")
</write>
<run>python3 hello.py</run>
User: <result tool="run" exit="0">hi</result>
Assistant: Created hello.py, it prints "hi" (tested).`
    : `<write path="hello.py">
print("hi")
</write>
User: <result tool="write" path="hello.py">Created hello.py (1 lines).</result>
Assistant: Created hello.py, it prints "hi". Run it with: python3 hello.py`;

  const who = subagentRole
    ? 'You are a sub-agent: a main agent gave you one task. Do only that task.'
    : 'You are a coding agent.';
  return `${who} You work inside the folder ${cwd} (${platform}).
You act by writing tool tags. The results come back in the next message.

TOOLS
${tools.join('\n')}

RULES
${rules.map((r, i) => `${i + 1}. ${r}`).join('\n')}${testLine}
${notes}
EXAMPLE
User: create hello.py that prints hi
Assistant: ${example}`;
}

function parseAttrs(src) {
  const attrs = {};
  if (!src) return attrs;
  const re = /([a-zA-Z_]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let m;
  while ((m = re.exec(src))) attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  return attrs;
}

export function stripFences(text) {
  let t = text.replace(/^\r?\n/, '').replace(/\r?\n[ \t]*$/, '');
  const m = t.match(/^\s*```[\w.+-]*[ \t]*\r?\n([\s\S]*?)\r?\n?\s*```\s*$/);
  if (m) t = m[1];
  return t;
}

/** Parses <old>/<new> pairs (or aider-style SEARCH/REPLACE blocks) from an edit body. */
export function parseEditBody(body) {
  const pairs = [];
  const re = /<old>([\s\S]*?)<\/old>\s*<new>([\s\S]*?)<\/new>/g;
  let m;
  while ((m = re.exec(body))) pairs.push({ old: stripFences(m[1]), new: stripFences(m[2]) });
  if (pairs.length) return pairs;
  const sr = /<{5,}\s*SEARCH\s*\n([\s\S]*?)\n={5,}\s*\n([\s\S]*?)\n?>{5,}\s*REPLACE/g;
  while ((m = sr.exec(body))) pairs.push({ old: m[1], new: m[2] });
  return pairs;
}

const tryJson = (s) => {
  try { return JSON.parse(s); } catch { return null; }
};

/**
 * Gemma's native argument syntax, nested: {tasks:[{title:<|"|>a<|"|>,task:<|"|>…<|"|>}]}.
 * Keys are bare words, strings are <|"|>…<|"|> (or "…"). Returns null if it is not that.
 */
function parseGemmaValue(src) {
  let i = 0;
  const ws = () => { while (i < src.length && /\s/.test(src[i])) i++; };
  const fail = () => { throw new Error('not gemma args'); };
  const value = () => {
    ws();
    if (src.startsWith('<|"|>', i)) {
      const end = src.indexOf('<|"|>', i + 5);
      if (end < 0) fail();
      const v = src.slice(i + 5, end);
      i = end + 5;
      return v;
    }
    const c = src[i];
    if (c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') j += src[j] === '\\' ? 2 : 1;
      const v = JSON.parse(src.slice(i, j + 1));
      i = j + 1;
      return v;
    }
    if (c === '{') {
      i++;
      const obj = {};
      ws();
      if (src[i] === '}') { i++; return obj; }
      while (i < src.length) {
        ws();
        const key = /^[A-Za-z_][\w-]*/.exec(src.slice(i));
        if (!key) fail();
        i += key[0].length;
        ws();
        if (src[i] !== ':') fail();
        i++;
        obj[key[0]] = value();
        ws();
        if (src[i] === ',') { i++; continue; }
        if (src[i] === '}') { i++; return obj; }
        fail();
      }
      fail();
    }
    if (c === '[') {
      i++;
      const arr = [];
      ws();
      if (src[i] === ']') { i++; return arr; }
      while (i < src.length) {
        arr.push(value());
        ws();
        if (src[i] === ',') { i++; continue; }
        if (src[i] === ']') { i++; return arr; }
        fail();
      }
      fail();
    }
    const lit = /^(-?\d+(?:\.\d+)?|true|false|null)/.exec(src.slice(i));
    if (!lit) fail();
    i += lit[0].length;
    return JSON.parse(lit[0]);
  };
  try {
    const v = value();
    ws();
    return i === src.length ? v : null;
  } catch {
    return null;
  }
}

/**
 * Gemma's native arguments are not JSON: {command:"ls -la"} or with its own
 * string delimiter, {command:<|"|>ls -la<|"|>}. Normalized, then parsed.
 */
function parseLooseArgs(s) {
  const strict = tryJson(s);
  if (strict && typeof strict === 'object') return strict;
  const loose = parseGemmaValue(s.trim());
  if (loose && typeof loose === 'object') return loose;
  if (s.includes('<|"|>')) {
    // Values between <|"|> delimiters may contain anything, quotes included.
    const out = {};
    for (const m of s.matchAll(/([A-Za-z_][\w-]*)\s*:\s*(?:<\|"\|>([\s\S]*?)<\|"\|>|(-?\d+(?:\.\d+)?|true|false))/g)) out[m[1]] = m[2] ?? m[3];
    if (Object.keys(out).length) return out;
  }
  const t = s.trim();
  if (!t.startsWith('{')) return null;
  const quoted = t.replace(/([{,]\s*)([A-Za-z_][\w-]*)\s*:/g, '$1"$2":');
  const j = tryJson(quoted);
  if (j && typeof j === 'object') return j;
  // Last resort: key:"value" pairs (values may contain anything but an unescaped quote).
  const out = {};
  for (const m of t.matchAll(/([A-Za-z_][\w-]*)\s*:\s*"((?:[^"\\]|\\.)*)"/g)) out[m[1]] = m[2].replace(/\\n/g, '\n').replace(/\\"/g, '"');
  return Object.keys(out).length ? out : null;
}

const quoteAttr = (k, v) => {
  if (v === undefined || v === null || v === '') return '';
  const s = String(v);
  return s.includes('"') ? ` ${k}='${s}'` : ` ${k}="${s}"`;
};

/** Our tag for a tool call given as name + JSON arguments (native function calling formats). */
function jsonToTag(name, a = {}) {
  const tool = ALIASES[name] || name;
  if (!TOOLS[tool]) return null;
  switch (tool) {
    case 'write': return `<write${quoteAttr('path', a.path ?? a.file)}>\n${a.content ?? a.text ?? ''}\n</write>`;
    case 'edit': return `<edit${quoteAttr('path', a.path ?? a.file)}>\n<old>${a.old ?? a.old_text ?? a.search ?? ''}</old>\n<new>${a.new ?? a.new_text ?? a.replace ?? ''}</new>\n</edit>`;
    case 'run': return `<run>${a.command ?? a.cmd ?? ''}</run>`;
    case 'web_search': return `<web_search>${a.query ?? a.q ?? ''}</web_search>`;
    case 'fetch': return `<fetch>${a.url ?? ''}</fetch>`;
    case 'agent': {
      // Several sub-agents in one call (models that make one call per turn): a list of tasks.
      const list = Array.isArray(a.tasks) ? a.tasks : [a];
      return list.map((t) => (typeof t === 'string' ? { task: t } : t))
        .map((t) => `<agent${quoteAttr('title', t.title ?? t.name)}>\n${t.task ?? t.prompt ?? t.description ?? ''}\n</agent>`).join('\n');
    }
    default: return `<${tool}${['path', 'start', 'end', 'pattern', 'depth'].map((k) => quoteAttr(k, a[k])).join('')} />`;
  }
}

/**
 * Models trained for function calling sometimes use their native format instead
 * of our tags. Rewrite the common ones into our tags:
 * - Gemma: <|tool_call>call:list path="." /<tool_call|>  (or call:name{json})
 * - Hermes/Qwen: <tool_call>{"name": "...", "arguments": {...}}</tool_call>
 *   (also what the client emits for API-level tool_calls).
 */
export function normalizeToolCalls(text) {
  // 1. Complete native calls: <|tool_call>call:name{args}<tool_call|> (or attributes inside).
  let t = text.replace(/<\|tool_call>\s*call:\s*([a-z_]+)([\s\S]*?)<tool_call\|>/gi, (m, name, rest) => {
    let r = rest.trim();
    const json = r.startsWith('{') ? parseLooseArgs(r) : null;
    if (json && typeof json === 'object') return jsonToTag(name, json) ?? m;
    r = r.replace(/\/?>?\s*$/, '').trim();
    const tool = ALIASES[name] || name;
    return TOOLS[tool] ? `<${tool}${r ? ` ${r}` : ''} />` : m;
  });
  // 2. Unclosed calls with braces: <|tool_call>call:name{args} (no <tool_call|>),
  // once the braces are balanced (not while the arguments are still streaming).
  t = t.replace(/<\|tool_call>\s*call:\s*([a-z_]+)\s*(?=\{)/gi, (m, name, offset, whole) =>
    (matchingBrace(whole, offset + m.length) < 0 ? m : `\u0003${name}\u0004`));
  t = replaceBraceCalls(t);
  // 3. Unclosed calls written like our tags: <|tool_call>call:read path="a.py" />
  t = t.replace(/<\|tool_call>\s*call:\s*([a-z_]+)(?=[\s/>])/gi, (m, name) => {
    const tool = ALIASES[name] || name;
    return TOOLS[tool] ? `<${tool}` : m;
  });
  t = t.replace(/<tool_call\|>/g, ''); // stray closers left by the forms above
  // 4. Hermes/Qwen JSON calls.
  t = t.replace(/<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g, (m, body) => {
    const o = tryJson(body);
    if (!o?.name) return m;
    const args = typeof o.arguments === 'string' ? tryJson(o.arguments) ?? {} : o.arguments ?? o.parameters ?? {};
    return jsonToTag(o.name, args) ?? m;
  });
  return t;
}

/** Index of the "}" closing the "{" at `start`, skipping strings ("…" and Gemma's <|"|>…<|"|>); -1 if not closed yet. */
function matchingBrace(s, start) {
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s.startsWith('<|"|>', i)) {
      const close = s.indexOf('<|"|>', i + 5);
      if (close < 0) return -1;
      i = close + 4;
      continue;
    }
    const c = s[i];
    if (c === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"') j += s[j] === '\\' ? 2 : 1;
      if (j >= s.length) return -1;
      i = j;
    } else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  return -1;
}

/** Rewrites marked unclosed brace calls (\u0003name\u0004{...}) into our tags. */
function replaceBraceCalls(t) {
  let out = '';
  let i = 0;
  while (true) {
    const a = t.indexOf('\u0003', i);
    if (a < 0) return out + t.slice(i);
    const b = t.indexOf('\u0004', a);
    const name = t.slice(a + 1, b);
    const end = matchingBrace(t, b + 1);
    const args = parseLooseArgs(t.slice(b + 1, end + 1));
    const tag = args && jsonToTag(name, args);
    out += t.slice(i, a) + (tag ?? `<|tool_call>call:${name}${t.slice(b + 1, end + 1)}`);
    i = end + 1;
  }
}

/**
 * Models often talk about the tools ("I will rewrite it with the `<write>` tag").
 * Taking that for a call is harmful: a <write> without path fails, and having no
 * closing tag it swallows the real call that follows. A tag is a mere mention when:
 * - it touches a backtick (inline code), or
 * - it has no attributes, sits in the middle of a sentence, and is not closed
 *   before the next tag of the same tool (or not closed at all). A real call can
 *   be glued to a sentence and span lines: "…the files.<run>curl -X POST \
 *   -d '{…}'</run>".
 */
function isMention(text, m) {
  const start = m.index;
  const end = start + m[0].length;
  if (text[start - 1] === '`' || text[end] === '`') return true;
  const hasAttrs = Boolean(m[2] && m[2].trim());
  if (hasAttrs) return false;
  const lineBefore = text.slice(text.lastIndexOf('\n', start - 1) + 1, start);
  if (!/\S/.test(lineBefore) || /```[\w-]*\s*$/.test(lineBefore)) return false; // starts the line
  const close = new RegExp(`</${m[1]}\\s*>`).exec(text.slice(end));
  if (!close) return true;
  const between = text.slice(end, end + close.index);
  return new RegExp(`<${m[1]}[\\s/>]`).test(between); // another call of the same tool starts first
}

/**
 * Finds tool actions in a model response.
 * Returns { actions: [{tool, args, raw, start, end, complete}], text } where text
 * is the prose with actions removed. With `final=false` (while streaming), an
 * action whose closing tag hasn't arrived yet is returned with complete=false.
 */
export function parseActions(text, { final = true } = {}) {
  text = normalizeToolCalls(text);
  const actions = [];
  const prose = [];
  let cursor = 0;
  OPEN_RE.lastIndex = 0;
  let m;
  while ((m = OPEN_RE.exec(text))) {
    if (m.index < cursor) continue;
    if (isMention(text, m)) continue; // "I'll use the `<write>` tag": talk, not a call
    const tool = ALIASES[m[1]] || m[1];
    const spec = TOOLS[tool];
    const attrs = parseAttrs(m[2]);
    const selfClosing = m[3] === '/';
    const openEnd = m.index + m[0].length;
    let body = '';
    let end = openEnd;
    let complete = true;

    if (!selfClosing) {
      const closeRe = new RegExp(`</(?:${m[1]}|${tool})\\s*>`, 'g');
      closeRe.lastIndex = openEnd;
      const close = closeRe.exec(text);
      if (close) {
        body = text.slice(openEnd, close.index);
        end = close.index + close[0].length;
      } else if (spec.needsBody) {
        // No closing tag: incomplete while streaming; at the end take the rest.
        body = text.slice(openEnd);
        end = text.length;
        complete = final;
      } else if (Object.keys(attrs).length === 0) {
        // <read>a.py with no closing tag: take the rest of the line.
        const nl = text.indexOf('\n', openEnd);
        const lineEnd = nl < 0 ? text.length : nl;
        if (nl < 0 && !final) complete = false;
        body = text.slice(openEnd, lineEnd);
        end = lineEnd;
      }
    }

    const args = { ...attrs };
    // Arguments given as child tags: <path>a.py</path>
    for (const name of spec.args) {
      if (args[name] !== undefined) continue;
      const child = body.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
      if (child) {
        args[name] = child[1].trim();
        body = body.replace(child[0], '');
      }
    }
    if (tool === 'write') {
      const c = body.match(/<content>([\s\S]*?)(?:<\/content>|$)/);
      if (c) body = c[1];
      args.content = stripFences(body);
    } else if (tool === 'edit') {
      args.body = body;
    } else if (args[spec.bodyArg] === undefined && body.trim()) {
      args[spec.bodyArg] = stripFences(body).trim();
    }

    prose.push(text.slice(cursor, m.index));
    actions.push({ tool, args, raw: text.slice(m.index, end), start: m.index, end, complete });
    cursor = end;
    OPEN_RE.lastIndex = end;
  }
  prose.push(text.slice(cursor));
  return { actions, text: prose.join('').replace(/\n{3,}/g, '\n\n').trim() };
}

/**
 * Removes reasoning blocks from a model answer: <think> (used by many reasoning
 * models) and <reasoning> (the wrapper we use to give the model back its own
 * earlier reasoning; a model may imitate it).
 */
export function splitThinking(text) {
  let thinking = '';
  let out = text.replace(/<(think|reasoning)>([\s\S]*?)(<\/\1>|$)/g, (_, __, t) => {
    thinking += t;
    return '';
  });
  // A model may also imitate the notes we give it back.
  out = out.replace(/^\s*\(My notes: ([^\n]*)\)\n?/, (_, t) => {
    thinking += t;
    return '';
  });
  return { text: out, thinking };
}

/**
 * The reasoning kept in the history is a short plain-text note: the end of the
 * model's reasoning (where its plan and conclusions are), so it does not start
 * over from scratch after each tool result. Not the full reasoning: with Gemma,
 * a long reasoning in the history (as a <reasoning> block, or in the template's
 * own thinking field) made the model emit only invisible tokens.
 */
export const NOTES_MAX_CHARS = 600;

export function withReasoning(content, thinking, maxChars = NOTES_MAX_CHARS) {
  const t = reasoningNote(thinking, maxChars);
  return t ? `(My notes: ${t})\n${content}` : content;
}

/**
 * The end of a reasoning, in whole sentences, each sentence once. A note cut
 * mid-word ("…n research findings") and repeated sentences were copied as is
 * by the model at each step, until it looped on them.
 */
export function reasoningNote(thinking, maxChars = NOTES_MAX_CHARS) {
  const t = (thinking || '').replace(/\s+/g, ' ').trim();
  const sentences = t.match(/[^.!?…]+(?:[.!?…]+|$)\s*/g) || [];
  const seen = new Set();
  let note = '';
  for (let i = sentences.length - 1; i >= 0; i--) {
    const key = sentences[i].trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    if (note.length + sentences[i].length > maxChars) break;
    seen.add(key);
    note = sentences[i] + note;
  }
  // Last sentence longer than the note: its end, from a word boundary.
  if (!note.trim()) note = t.slice(-maxChars).replace(/^\S*\s+/, '');
  return note.trim();
}

/**
 * Where a generation started looping: a passage repeated at least three times
 * in a row at the end of `s` (the last copy may be partial), over at least
 * minRun characters. Returns the index just after the first copy (-1 if no loop).
 */
export function findRepetition(s, { minRun = 300, maxPeriod = 2000 } = {}) {
  const n = s.length;
  if (n < minRun) return -1;
  const probe = s.slice(-20);
  let at = s.lastIndexOf(probe, n - 21);
  for (let tries = 0; at >= 0 && tries < 50; tries++) {
    const d = n - 20 - at; // candidate period
    if (d > maxPeriod) break;
    if (d >= 20) {
      // Back to where the repeating starts.
      let k = n - d - 1;
      while (k >= 0 && s[k] === s[k + d]) k--;
      const first = k + 1;
      const run = n - first;
      if (run >= 3 * d - 20 && run >= minRun) {
        // Keep one copy, cut at the end of a line or sentence if there is one.
        // (the window overlaps the next copy by two characters, so that a
        // boundary just at the end of the copy is found)
        const window = s.slice(first, first + d + 2);
        const nl = window.lastIndexOf('\n');
        const end = nl > 1 ? nl : Math.max(...['. ', '! ', '? '].map((p) => window.lastIndexOf(p) + 1));
        return end > 1 ? first + end + 1 : first + d;
      }
    }
    at = s.lastIndexOf(probe, at - 1);
  }
  return -1;
}

/** Gemma's channel markers, when they leak into an answer or a reasoning (see makeChannelSplitter). */
export function stripChannelMarkers(s) {
  return String(s ?? '').replace(/(?:<\|channel>)+(?:[a-z_]+\n)?|<channel\|>/g, '');
}

export function stripReasoning(content) {
  return content.replace(/<reasoning>[\s\S]*?<\/reasoning>\n?/g, '').replace(/^\(My notes: .*\)\n?/m, '');
}

/** Converts full <reasoning> blocks (older versions) into short notes. */
export function legacyReasoningToNotes(content) {
  return content.replace(/<reasoning>\n?([\s\S]*?)\n?<\/reasoning>\n?/g, (_, r) => withReasoning('', r));
}

export function formatResult(tool, attrs, output) {
  const a = Object.entries(attrs)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => ` ${k}="${String(v).replace(/"/g, "'").slice(0, 120)}"`)
    .join('');
  return `<result tool="${tool}"${a}>\n${output}\n</result>`;
}
