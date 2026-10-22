# Poney

A desktop coding agent (in the spirit of Claude Code / Codex) built for **small local models**:
Ollama, LM Studio, llama.cpp server, vLLM. The interface is in French.

```bash
npm install
npm start            # desktop app
npm test             # unit tests
node src/cli.js --cwd ./my-project --model qwen2.5:14b "task"   # headless mode
```

## What is done for small models

- **Short system prompt** (~1,100 tokens) with a few examples, instead of several thousand. It includes rules for
  talking with the user, against the habits of small fine-tuned models: answer first and briefly, no restating the
  user, no filler; read irony and sarcasm as such; ask one question when the request is unclear instead of guessing.
  It also tells the model to search the web (with an example) when the user mentions something it does not know or
  that may have changed, instead of guessing.
- **Date and time on each message** (`[Thu 2026-10-22 14:05] …`): the model knows when it is, and how much time
  passed between two messages. Added to the message, not to the system prompt, so the server cache is never lost.
- **The model's own temperature** by default (left to the server and the model's preset); a value can still be set.
  A forced low temperature (0.2, the old default) made answers flat and loops likelier.
- **Tools as text tags**, not JSON: `<write path="a.py">…</write>`, `<run>…</run>`.
  Code does not need escaping. The parser is lenient: aliases (`bash`, `read_file`…),
  arguments as attributes or child tags, optional quotes, ``` fences removed.
- **Only 8 tools**: list, read, search, write, edit, run, web_search, fetch (plus `plan`, `agent`, `remember`,
  `forget`, `recall`).
- **Project search like a web search** (`<search>keywords</search>`): files ranked by relevance (rare words weigh
  more, words in the path and definitions that contain them count more, tests after the code), each with its best
  lines and their numbers, then the agent reads only those lines. Whole words, identifiers split the code way
  (`loadConfig`, `load_config` → load, config), word roots match; git's file list when there is one (respects
  .gitignore). The prompt asks to search first instead of reading files one by one. `pattern="regex"` still lists
  every matching line. About 1 s for 3,000 files, less once cached.
- **Lenient editing**: `<old>` may have the wrong indentation (re-indented automatically),
  and on failure the agent gets the closest lines of the file.
- **Syntax check** after every write (.py, .js, .json).
- **Guard against rewrites from memory**: `<write>` on an existing file is refused if its content is not
  visible in the history (read with `<read>` or written by the model, and not removed by a compaction).
  A large shrink of a file (more than half of its lines) triggers a warning.
- **Test gate**: the agent cannot finish while code it modified during the turn has not run successfully.
  If a *test command* is configured, it runs automatically and must pass. Documentation and data/config files
  (Markdown, text, JSON, YAML, TOML…) do not count: there is nothing to run.
- **Early stop** of the generation as soon as an action needs a result (no invented results).
- **Context management**: bounded tool outputs, adjustable `num_ctx` (native Ollama), and **compaction**:
  as late as possible, when the next call would no longer fit in the window (minimal answer + estimation
  margin, ~80-84 % of a 16k window), old messages are replaced by a summary (written by the model, validated,
  with a fallback) plus facts extracted mechanically (modified files, last commands). Compacting rarely but a lot
  keeps the start of the prompt stable, so the server cache stays usable. Token estimates are calibrated on the
  real counts returned by the server. The context size actually loaded by the server (LM Studio, llama.cpp server,
  vLLM) is detected and caps the setting. If the model cannot write the summary, a fallback summary is built
  (requests, previous summary, last notes) and the reason is shown. The requested answer size adapts to the room
  left (never past the window); an answer cut by the limit never runs an unfinished action, and if the cut comes
  from a lack of room, the context is compacted and the step retried.
- **Reasoning kept as a short note**: the end of the model's reasoning (~600 characters, whole sentences, each
  sentence once) is given back in a `<reasoning>` block before its messages, so it does not start over after each
  tool result. Not the whole reasoning: with Gemma, that made the model produce only invisible tokens. Not a prose
  line either: an earlier "(My notes: …)" form was copied by the model into its answers. Older conversations are
  converted when opened (one full prompt read).
- **Loop detection**: Gemma reopening its reasoning channel (`<|channel>thought`) a third time while reasoning, or a
  passage repeated three times in a row (in the reasoning or the answer, not inside a file
  being written) stops the generation; one copy is kept. Without an action, the model is told to act instead of
  restating its plan (twice, then the turn stops).
- **Tools declared natively** to the LM Studio models that support it (`tool_use`).
- **Raw mode for Gemma in LM Studio**: the prompt is formatted with the model's template (SDK) and generated through
  `/v1/completions`, which returns every token. LM Studio's chat endpoint held back everything after the start of a
  tool call (sometimes opened inside the reasoning): generation went on with nothing coming out. The reasoning
  (`<|channel>thought…<channel|>`) is split by the app.
- **Call at the end of the reasoning, then silence**: if the model ends its reasoning (or its answer) with a complete
  call and nothing visible comes out for 10 s, the generation is stopped and the call runs. A plan that mentions a
  command and goes on is not interrupted.
- **Invisible-output guard**: if the model generates without producing anything visible, the app notices (45 s
  after the prompt is read) and retries without the reasoning notes.
- **Server cache preserved**: the start of the prompt never changes from one call to the next (except at
  compaction), so the server only reads the new tokens. The compaction summary is requested as a continuation of
  the conversation already in cache (seconds instead of minutes of re-reading on modest hardware).
- Nudge when the model pastes code instead of writing it to a file.
- Project notes read from `AGENTS.md` / `PONEY.md` / `CLAUDE.md`.

## Interface

- **Edit a previous message and relaunch** ("✎ Modifier" on hover): the agent goes back to its state before that
  message, even across a compaction (the replaced history is archived), and what follows is removed. Files already
  modified by the agent are not restored. When the exact state is gone (old conversations, a resume point lost in a
  crash), the history is rebuilt from the saved transcript. If the relaunch fails, the editor stays open with the text.
- **Resume from here** (on hover over an action): the agent goes back to just after the message that asked for that
  action, runs it again (with the rest of its batch; results of the batch's earlier actions are kept) and goes on.
  Useful after a stop or a failure (slow Tor, missing file…). A group of sub-agents restarts as a whole.
  Works for actions of old conversations too: the state is then rebuilt from the transcript.
- **Saved, renamable conversations** (✎ or double-click), per project folder
  (`~/Library/Application Support/poney/conversations/`): they can be reopened after a restart, and the agent
  resumes with its history. Saved during a turn too (at every answer and action): a crash or a Ctrl-C only loses a few
  seconds, and a turn that was interrupted is flagged when the conversation is reopened. If the window crashes, it
  reloads by itself and the agent goes on; errors go to `logs/main.log`.
- **Quote a passage**: select text in the conversation, a "❝ Citer" button appears; it adds the passage to the
  input as a quote (`> …`, formulas as their LaTeX source). Quotes show as quotes in the sent message.
- **Several conversations at once**: switching conversation does not stop the one shown; it goes on in the
  background (its events are recorded, not drawn). Coming back shows it as it is now, the answer being written
  included, at the same reading position (or following the end if you were there). In the list: a spinner while
  one works in the background, an orange dot when it waits for an approval, a blue dot when it finished unseen.
  Idle conversations stay in memory (8 at most) for a quick return. Generations at the same time share the GPU.
- **Sidebar grouped by project**: all the conversations, one collapsible group per project (the open one stays
  unfolded), a "＋" on each group to start a conversation there, and "＋ Ajouter un projet…".
- **Conversations outside any project** (the "Hors projet" group): same tools, but the agent works in a folder of
  the conversation's own (`~/Library/Application Support/poney/off-project/<id>/`), shown in the file browser.
  Deleting one deletes its folder; a new one abandoned before its first message leaves nothing behind.
- **Markdown answers**: tables (GitHub style, with alignment) and LaTeX formulas rendered by KaTeX
  (`$…$`, `\(…\)` inline; `$$…$$`, `\[…\]` as blocks). Prices like "$5 and $10" stay text.
- **File browser** that updates when the agent writes, and reveals the modified file.
- **Web / Terminal switches** under the input box (`--no-web` / `--no-shell` in the CLI): a disabled tool
  disappears from the system prompt (shorter prompt) and is refused if the model uses it anyway.
- **System prompt editable per conversation** ("Prompt système" button): see the generated prompt, edit it, and it is
  saved with the conversation. A "modifié" badge marks a custom prompt.
- **Context gauge** under the input (the tick marks the compaction threshold); a click compacts on demand.
  Summaries appear in the transcript, expandable.
- **Prompt reading progress** (LM Studio): percentage and estimated time left in the status bar before the first
  token. LM Studio is detected automatically behind "OpenAI compatible": the prompt is read through its SDK (which
  reports progress), then the answer is generated over HTTP reusing that cache. Generation does not go through the
  SDK, which LM Studio cuts after ~5 min. Other servers do not expose this information.
- **Stream cut by the server**: what was already written is kept and complete actions run.
- **Native tool calls understood**: if the model uses its native format (Gemma `<|tool_call>…`, Hermes/Qwen
  `<tool_call>{json}`, `tool_calls` fields of the OpenAI/Ollama APIs), the call is converted to our tags.
- **Time and speed**: a timer in the status bar during the answer, then one line under the final answer:
  total time, tokens and tokens/s over all the model calls (server counts, or estimates marked "≈").
  Streaming redraws are batched (~10 per second), so long generations keep the window responsive.
- **Tor (optional)**: web search and page fetching through Tor's SOCKS proxy (`tor` daemon on 9050 or Tor Browser
  on 9150, detected automatically), names resolved by Tor (`socks5h`), search through DuckDuckGo's .onion service.
  If Tor cannot be reached, the request is refused, never sent in the clear. Optionally, terminal commands get the
  proxy variables (works for curl, git, wget… not a general guarantee). The local model server is not affected.
  Test button (exit IP seen by check.torproject.org); CLI: `--tor`.
  Live status next to the switch (green connected, orange "connexion 45 %", red stopped or blocked): through Tor's
  control port (9051 / 9151, cookie authentication) when enabled, otherwise through a test connection at most every
  30 s.
- **Sub-agents**: the agent can delegate independent tasks (`<agent title="…">task</agent>`, several in a row, or a
  `tasks` list in one native call); they run at the same time (2 by default, adjustable), each with its own history,
  then the agent gets all the reports. No sub-sub-agents. Writing to a file modified by another agent since it was
  read is refused (it must be read again), and writes to the same file are serialized. One card per sub-agent in the
  transcript (task, live log, report); "Sous-agents" switch.
  One GPU: speed is shared; measured with gemma-4 on two modules + tests: 6 min 56 instead of 10 min 41.
- **Compaction summaries for conversations too**: about 4% of the window (~490 words for 16k), under the headings
  Context / Discussion / Work done / Open, with the specifics kept (names, numbers, the user's wording); an earlier
  summary is carried over, not dropped. The replaced history is always archived.
- **`<recall>keywords</recall>`**: searches the part of the conversation no longer in view (the archives) and brings
  back excerpts of the matching messages, in order (accents ignored, quoted phrases kept whole).
- **Automatic recall**: with each user message, the app searches the out-of-context history with the message's words
  (rare words weigh more, word roots match, words still in view count for nothing) and, when an earlier passage
  clearly matches, attaches the 1 or 2 best excerpts to the message (~300 tokens at most), marked "maybe relevant".
  The message shows "↩ n passages anciens joints", expandable. Nothing is attached when nothing clearly matches.
- **Chapter index**: each compaction adds a line to the summary (dates from the message stamps, topics written by
  the model, keywords of that part added when the line is vague), so the model knows what is out of view and what to
  look for with `<recall>`. 15 lines at most (the oldest merged).
- **Memory per conversation** (`<remember>` / `<forget>`): the agent notes what must not be lost in a long
  conversation (goals, decisions, preferences, constraints), at most 20 short notes (~600 tokens). The notes go word
  for word into compaction summaries, and come back with a user message when their last full view is more than a
  third of the window behind, so they stay in view without costing room at every message. The 🧠 button under the
  input shows them; you can add or remove notes (shown to the agent with your next message). Saved with the
  conversation, restored by rewinds. Lasting instructions in the user's messages ("réponds toujours en anglais",
  "from now on…", "tutoie-moi", "retiens que…") are noted by the app itself, in the user's words, and shown under
  the message; when the model notes the same thing in its own words, its note replaces the app's. The prompt has an
  example of noting a constraint before answering.
- **Plan** (`<plan>`, like Claude Code's task list): for one request, the agent writes its task list (`- [ ]` /
  `- [x]`) and rewrites it as it goes; it stays pinned above the input. A new message starts without a plan. The
  agent cannot finish while tasks are left unchecked (it is sent back to them twice at most; it may also rewrite
  the plan without the tasks no longer needed). After each result, one line says where it stands
  ("Plan: 2/5 done. Next: …"), so the model does not restate its plan in its reasoning. Tasks starting with
  `@agent` are independent: they start at once in sub-agents, each given the request, the whole plan (its task
  marked) and its task; the plan step waits for their reports. A delegated task is never started twice. The plan
  is saved with the conversation, kept through compaction and restored by rewinds.
- **Viewer** with syntax highlighting and image preview; paths in the agent's actions are clickable. Markdown
  documents open formatted (GitHub Markdown, LaTeX formulas, highlighted code, project images; links to project
  files open in the viewer, web links in the browser), with a "Code" button to see the source; the choice is
  remembered. Raw HTML in a document is sanitized.

## Platforms

Developed and tested on macOS. Windows is supported in the code but not tested on a real machine yet: commands run
in `cmd.exe` (the model is told so), a stopped command kills its whole process tree (`taskkill /T`), files with
Windows line endings (CRLF) can be edited and keep them, paths are shown with `/`, and the Python syntax check uses
`py -3` or `python`. Linux should work like macOS.

## Bun

`bun install`, `bun start` and `bun run test` work (the tests then run with Node). The app itself always runs in
Electron, so its runtime is Node whatever starts it. Two limits when Bun is the runtime:

- `bun test` (Bun's own test runner) only partly emulates `node:test`: use `bun run test`.
- `bun src/cli.js` works, but **Tor is refused** under Bun: its `node:http` ignores the SOCKS agent, so requests
  would go out in the clear. Use `node src/cli.js --tor` for Tor from the command line.

## Without Tor

Tor is off by default and optional: without it, web search and fetching go directly to the sites. If the Tor switch
is turned on while Tor is not running, web requests are refused with an explanation (never sent in the clear), and
the status dot is red.

## Layout

- `src/agent/` — core, independent of the UI (loop, protocol, tools, LLM client, web, Tor)
- `src/main.js`, `src/preload.cjs`, `src/renderer/` — Electron app
- `src/conversations.js`, `src/files.js` — conversation storage, file access for the viewer
- `src/cli.js` — command-line runner
- `scripts/brand-electron.mjs` — macOS, development: renames the Electron bundle to `Poney.app` and gives it the app's icon, so the Dock shows them (run by `npm start`)
- `assets/` — app icon (`icon.svg` source; `icon.png` for the macOS Dock, `icon.icns` for the bundle, `icon-square.png` for the Windows/Linux taskbar)

## Tor on a network that blocks Tor

If the `tor` service stays stuck at 10 % ("Connecting to a relay"), the network blocks Tor relays: you need
bridges. With Tor Browser installed, its transports and built-in bridges can be reused:

```bash
brew install tor
mkdir -p /opt/homebrew/etc/tor/pt
ln -sf "/Applications/Tor Browser.app/Contents/MacOS/Tor/PluggableTransports/lyrebird" /opt/homebrew/etc/tor/pt/lyrebird
```

Then, in `/opt/homebrew/etc/tor/torrc`: `ControlPort 127.0.0.1:9051` and `CookieAuthentication 1` (for the
connection status in the app), `UseBridges 1`, the `ClientTransportPlugin … exec
/opt/homebrew/etc/tor/pt/lyrebird` lines and the `Bridge …` lines (snowflake, obfs4) from Tor Browser
(`chrome/toolkit/content/global/pt_config.json` inside `Contents/Resources/omni.ja`), then `brew services restart tor`.
