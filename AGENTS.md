# Poney

Electron desktop coding agent for small local models. Vanilla JS, ES modules, no bundler or framework. See README.md for features and layout.

## Commands

- `npm start`: run the app.
- `npm test`: all the tests (about 2 minutes). `node --test test/x.test.js` for one file.
- `npm run cli`: the command-line runner.

## Test in isolation

Never run the app on real data. Start a separate instance with its own data folder, and a debugging port to drive it:

`PONEY_DATA=/tmp/poney-test npx electron . --remote-debugging-port=9335`

Stop only your own instance, not one the user is running. The tests use fake model servers: `npm test` needs no model.

## Where things are

- `src/agent/`: the local harness, without UI. `protocol.js` builds the system prompt and parses tool tags, `agent.js` is the loop, `context.js` is compaction, `triage.js` is the assessment.
- `src/agent/claude.js`: Claude models through the Agent SDK. It only translates events: none of the local harness runs there, except skills.
- `src/skills/`: built-in skills. Keep each under 1700 characters, with exact trigger phrases.
- `src/main.js`: sessions and IPC. `src/preload.cjs` must expose each new call.
- `src/renderer/`: the interface.

## Rules

- Interface text is in French. Code, comments, commits and the README are in English.
- Every token of the system prompt costs each message on small models. Add to it only what a skill or the app cannot do.
- Prompt size matters to tests: `test/context.test.js` fills histories just under the budget, so a longer prompt needs those sizes adjusted.
- Prefer the app deciding over asking the model: small models forget.
- Clicks on `-webkit-app-region: drag` areas never reach the page, and CDP events bypass this, so a passing CDP test proves nothing there.
- Check animations mid-transition, not only their end state.
- Add a test for each behavior change in `src/agent/`. Renderer changes need a real run in an isolated instance.
- Do not write "Claude Code" in the interface. The Claude models use the machine's own login, for personal use: a public release needs an API key or Anthropic's approval.
