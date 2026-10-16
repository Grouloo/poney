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
};

const ALL_NAMES = [...Object.keys(TOOLS), ...Object.keys(ALIASES)];
// Longest first so "web_search" wins over "search".
const NAME_RE = ALL_NAMES.sort((a, b) => b.length - a.length).join('|');
const OPEN_RE = new RegExp(`<(${NAME_RE})(\\s[^<>]*?)?\\s*(/?)>`, 'g');

/** Tools that can be switched off in the settings, and the config flag for each. */
export const TOOL_FLAGS = { run: 'shellEnabled', web_search: 'webEnabled', fetch: 'webEnabled' };

export function isToolEnabled(tool, config) {
  const flag = TOOL_FLAGS[tool];
  return !flag || config[flag] !== false;
}

export function buildSystemPrompt({ cwd, platform, projectNotes, testCommand, shell = true, web = true }) {
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
  rules.push(`When the task is finished${shell ? ' and tested' : ''}, answer WITHOUT any tool tag: a short summary for the user, in the user's language.`);

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

  return `You are a coding agent. You work inside the folder ${cwd} (${platform}).
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

/**
 * Finds tool actions in a model response.
 * Returns { actions: [{tool, args, raw, start, end, complete}], text } where text
 * is the prose with actions removed. With `final=false` (while streaming), an
 * action whose closing tag hasn't arrived yet is returned with complete=false.
 */
export function parseActions(text, { final = true } = {}) {
  const actions = [];
  const prose = [];
  let cursor = 0;
  OPEN_RE.lastIndex = 0;
  let m;
  while ((m = OPEN_RE.exec(text))) {
    if (m.index < cursor) continue;
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

/** Removes <think>...</think> blocks some reasoning models put in their content. */
export function splitThinking(text) {
  let thinking = '';
  const out = text.replace(/<think>([\s\S]*?)(<\/think>|$)/g, (_, t) => {
    thinking += t;
    return '';
  });
  return { text: out, thinking };
}

export function formatResult(tool, attrs, output) {
  const a = Object.entries(attrs)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => ` ${k}="${String(v).replace(/"/g, "'").slice(0, 120)}"`)
    .join('');
  return `<result tool="${tool}"${a}>\n${output}\n</result>`;
}
