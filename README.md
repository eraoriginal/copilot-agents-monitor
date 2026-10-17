# agent-monitor

A live view of GitHub Copilot agents and subagents in VS Code: who delegated to whom, which
agents are working right now, what each one calls, the tokens and the cost, turn by turn.

It works for every workspace at once. One local process receives what VS Code reports and
serves the page; nothing leaves the machine.

```bash
npm start          # or: pnpm start
```

Then open <http://localhost:4319>.

## Set up VS Code once

Add to your VS Code **user** settings:

```jsonc
"github.copilot.chat.otel.enabled": true,       // the chat extension's harness
"chat.agentHost.otel.enabled": true,            // the agent host (Copilot harness), VS Code's default since 1.14x
"chat.agentHost.otel.otlpProtocol": "http/json"
```

Then **quit VS Code completely and reopen it**: the agent host reads these settings when it
starts, not when they change. A window reload is not enough.

The monitor listens on `localhost:4318`, the endpoint Copilot exports to by default, so no
endpoint needs setting. It listens on both `127.0.0.1` and `::1`, because `localhost` resolves to
IPv6 first on Windows.

Optional: `npm run install-hooks` shows a hook file for `~/.copilot/hooks/`, and `-- --yes` writes
it. See [Hooks](#hooks) for what they add and their status.

## What the page shows

- **Totals**: cost in AI credits and dollars, wall clock, agents running, tokens in and out,
  cache hit rate, LLM and tool calls.
- **Orchestration**: each turn of the root agent, and the subagents it delegated to, with their
  status (running, done, stalled, failed), model, duration, tokens, cost and last tool call.
  Click a card to filter the log and the timeline to that agent.
- **Progress**: the agent's todo list when one is reported, otherwise subagents done.
- **Cost by agent** and **by model**.
- **Timeline**: one row per agent, its LLM calls and tool calls in time.
- **Session log**: every call as it arrives.

Sessions from the last two days are listed; the page follows the latest one unless you pick
another.

## Where the data comes from

**OpenTelemetry, the main source.** Copilot exports one trace per turn, in the GenAI semantic
conventions:

| Span | Carries |
|---|---|
| `invoke_agent <name>` | one agent run; a subagent's is a child of the `execute_tool task` that started it |
| `chat <model>` | one LLM call: tokens in, out, cached, reasoning; `github.copilot.nano_aiu` |
| `execute_tool <tool>` | one tool call, with `gen_ai.agent.name` |
| `permission` | whether the call was approved |

Spans reach the monitor 0 to 5 seconds after they end: the exporter batches.

**Cost** is what Copilot reports: `github.copilot.nano_aiu` is the call's cost in billionths of an
AI credit, and a credit is a cent. When a span carries no such attribute, the monitor estimates
from [`src/pricing.json`](src/pricing.json), list prices per million tokens, and says so.

### Hooks

Hooks add what spans leave out: the moment a subagent starts, and tool arguments (the brief a
subagent receives, the todo list) without turning on content capture. The hook script appends
each event to a file and exits 0 without writing to stdout: it never blocks a call and never takes
a permission decision another hook should take.

Measured on 2026-10-17, VS Code 1.142, Copilot Free, agent host: **workspace hooks did not run at
all**, whatever the command. The monitor works on spans alone; check hooks on a paid plan before
relying on them.

## Known limits

- **The root agent reports when its turn ends.** In the agent host, the root agent's spans, its
  own LLM calls included, arrive when its turn ends; subagents report live. Until then the root
  shows as running with its calls pending, or as a placeholder caller above its subagents.
- **A subagent's name** appears with its first tool call or its own span; until then it shows as
  `subagent · identifying…`.
- **Briefs and todo lists** need hooks, or `chat.agentHost.otel.captureContent: true`. Content
  capture puts prompts, file contents and tool arguments into the spans, and so into
  `~/.agent-monitor`. It stays local, but turn it on knowingly.
- **Managed settings win.** An organization can set Copilot's OTel settings by policy; personal
  settings are then ignored.

## Data and privacy

- Everything is kept in `~/.agent-monitor` (`AGENT_MONITOR_HOME` to move it), one file per day
  and kind: `hooks-*.jsonl`, `spans-*.jsonl`. Files older than 14 days are deleted at start.
- Both servers listen on the loopback interface only, and refuse requests whose `Host` is not a
  local name.
- The page renders every value as text, never as HTML.

## Options

```text
node src/server.js [--otlp-port 4318] [--ui-port 4319] [--days 2] [--retention 14] [--raw] [--demo]
```

- `--demo` replays a conductor run live on <http://localhost:4329>, without VS Code: three scouts
  in parallel, designers, an implementer, two reviewers, on Haiku, Sonnet and Opus.
  `npm run demo` does the same.
- `--raw` also saves every OTLP request body under `~/.agent-monitor/raw`, to inspect a format.

## Try it on the playground

`playground/` holds a `lead` agent that writes a todo list and starts two read-only subagents in
parallel. Open the folder in VS Code, trust it, then:

```bash
code chat -m lead "Run your three steps on sample/."
```

## Development

No dependencies. Node 20.19 or later.

```bash
npm test
```

| Path | Role |
|---|---|
| `src/server.js` | the OTLP receiver, the hook file tail, the page and its event stream |
| `src/otlp.js` | OTLP/JSON decoding |
| `src/hook.js` | the hook command |
| `src/store.js` | day files: append, read, tail, purge |
| `public/model.js` | the state model, shared by the page and the tests |
| `public/app.js` | the page |
| `src/demo.js` | the `--demo` run |
