# Exam Runtime reference

For the shortest setup, see the [project README](../README.md). For MCP host configuration and agent prompts, see the [AI agent integration guide](ai-agent-integration.md).

## Install and run

Use the Node.js 26 LTS line. The repo pins `26.13.1` in `.nvmrc` and requires `>=26.13.1 <27`. Run these commands from the repository root:

```sh
nvm install && nvm use  # if you use nvm
npm ci
npm run build
npm test
npm exec -- exam-runtime --help
npm exec -- exam-runtime init
npm exec -- exam-runtime serve
```

Open <http://127.0.0.1:3000/>. `npm run build` builds the TypeScript packages and browser UI. `npm test` builds the backend and runs Vitest. `npm run typecheck` checks the TypeScript project, and `npm run test:watch` starts Vitest in watch mode after a backend build.

For development, run `npm run dev:api` and `npm run dev:web` in separate terminals. Open <http://127.0.0.1:5173/>. Vite proxies `/api` to the backend. Restart `dev:api` after backend edits. If you change the API port, set `EXAM_RUNTIME_PORT` to the same value in both terminals. The CLI and MCP UI link checks use the built UI at the backend port, not the Vite dev URL.

`better-sqlite3` is a native dependency. If no prebuilt binary is available for your Node version and platform, install the local `node-gyp` prerequisites (Python 3 and a C/C++ toolchain: `make` and a compiler on Linux, Xcode Command Line Tools on macOS, or Visual Studio Build Tools with Desktop development with C++ on Windows). To force a source build, retry `npm ci` with `npm_config_build_from_source=true` in the environment.

### Run the npm package with npx

From the repository root, run `npm ci` and `npm run pack:npm`. This builds the CLI, browser UI, and stdio server into `dist/npm/exam-runtime-mcp-VERSION.tgz`. The tarball works outside the repository. Its runtime dependencies install through npm.

```sh
# Use the absolute tarball path when launching from a different directory.
version=$(node -p 'require("./package.json").version')
npx --yes --package="$PWD/dist/npm/exam-runtime-mcp-$version.tgz" exam-runtime --help
```

Use `exam-runtime mcp` with that same `npx --package=…` launcher in your host's stdio configuration. See the [AI agent integration guide](ai-agent-integration.md#2-register-the-mcp-server-in-your-agent-host). To use the published version instead of a local tarball, run `npx --yes exam-runtime-mcp mcp`.

## Data and port

The CLI, HTTP server, and MCP process must use the same SQLite database. The path is selected in this order:

1. `EXAM_RUNTIME_DB_PATH`, a complete database file path.
2. `EXAM_RUNTIME_DATA_DIR/exam-runtime.sqlite3`.
3. `exam-runtime/exam-runtime.sqlite3` under the platform data home: absolute `XDG_DATA_HOME` if set, otherwise `~/Library/Application Support` on macOS, `%LOCALAPPDATA%` (or `~/AppData/Local`) on Windows, or `~/.local/share` elsewhere.

Use absolute overrides so they work from any process working directory. `exam-runtime init` prints the selected path. The HTTP port defaults to `3000`. Set `EXAM_RUNTIME_PORT` in each process that serves or generates browser URLs. The `serve` and `exam start` commands also accept `--port` to override it for that command.

## Architecture

| Path | Role |
| --- | --- |
| `packages/schemas` | Zod schemas for exam definitions, answers, and grades |
| `packages/storage` | SQLite persistence and migrations via `better-sqlite3` |
| `packages/core` | Shared exam lifecycle, session snapshots, timer enforcement, and grading |
| `packages/server` | Fastify candidate API and static browser UI serving |
| `apps/web` | React candidate UI for browsing, taking, and reviewing exams |
| `packages/cli` | Local operator commands and server entry points |
| `packages/mcp` | Stdio tools and resources for trusted operators and agents |

## CLI

Use `npm exec -- exam-runtime` followed by a command:

| Command | Effect |
| --- | --- |
| `init` | Create or migrate the local database. |
| `serve [--port <port>]` | Serve the candidate API and built UI on `127.0.0.1`. |
| `agent create <id>` | Create a local MCP agent scope and print its credential once as JSON (`agent_id` and `token`). |
| `exam import <file> [--agent <id>]` | Validate a JSON definition and import it as a draft with a new exam ID. Assign it to an existing agent scope, or to `local` by default. |
| `exam list [--status draft\|published] [--subject <subject>]` | List exam summaries, with optional filters. |
| `exam show <exam-id>` | Print the full record, including answer keys. Trusted use only. |
| `exam publish <exam-id>` | Publish the exam so candidates can start attempts. Published definitions cannot be edited. |
| `exam start <exam-id> [--port <port>]` | Start the timer immediately and print the session URL. This does not launch the UI server. |
| `results <session-id>` | Show the attempt status or final score. |
| `mcp` | Run the MCP server over stdin and stdout. |

For a candidate who is not ready to start, share the exam overview URL (`/exams/<exam-id>`), not a URL from `exam start`. The timer starts when the candidate starts an attempt from the overview.

## Exam JSON

See [the AWS practice exam](../examples/aws-practice.json) for a full answer-key example and [the source schema](../packages/schemas/src/index.ts) for validation rules. Use `schema_version: "1.0"`. Unknown fields are rejected except for entries inside `metadata` maps.

| Object | Fields and defaults |
| --- | --- |
| Root | `schema_version`, `exam`, optional `grading`, optional `assistance`, and `questions` (1 to 500). |
| `exam` | Required `title`. Optional `description`, `instructions`, `subject` (`General`), `difficulty`, `mode` (`exam` by default, `practice`, or `learning`), `duration_minutes` (integer 1 to 1440, default 60), `shuffle_questions` (false), `allow_review` (true), `auto_submit_on_timeout` (true), and `metadata`. |
| `grading` | `mode` (`answer_key` by default or `agent_graded`), `correct_points` (1), `incorrect_points` (0), `unanswered_points` (0), `passing_percent` (70), and `levels` (empty by default). Each level is `{ "name": "Proficient", "min_percent": 70 }`. Names and thresholds must each be unique. |
| Each question | Required `id`, `type`, and `text`. Optional `domain` (`General`), `difficulty`, `options`, `correct_answers`, `points`, and `metadata`. `points` is a map of per-question overrides for `correct_points`, `incorrect_points`, and `unanswered_points`. |

Question IDs must be unique within an exam. Option IDs must be unique within a question. Both use 1 to 80 letters, digits, underscores, or hyphens. Exam and session IDs are UUIDs generated by the runtime. Options are objects with `id` and `text`; select questions need 2 to 30 options. Keys use option IDs, not their display text.

| Question `type` | Definition | Candidate response value |
| --- | --- | --- |
| `single_select` | `options` and one key ID in `correct_answers` | One option ID string |
| `multi_select` | `options` and one or more unique key IDs in `correct_answers` | Array of unique option IDs |
| `true_false` | No `options`; one string key, `"true"` or `"false"`, in `correct_answers` | Boolean `true` or `false` |
| `free_text` | Only in `agent_graded`; omit `options` and `correct_answers` | Text string |

Select and true/false keys are required in `answer_key` mode and optional in `agent_graded` mode. `null` clears a response. An empty selection or whitespace-only free-text response also counts as unanswered.

### Assistance settings

Assistance is off if `assistance` is omitted or `enabled` is `false`. With `"assistance": { "enabled": true }`, all other settings use these defaults:

| Field | Values and default |
| --- | --- |
| `enabled` | Boolean, default `false`. |
| `exam_mode` | `disabled` or `after_submission` (default). Never available during an exam-mode attempt. |
| `practice_mode`, `learning_mode` | `disabled`, `after_submission`, or `on_request` (default for both). `on_request` allows eligible requests before the deadline and in review. |
| `allowed_types` | Array of 1 to 3 unique values from `hint`, `detailed`, and `why_wrong`. Default: all three. |

After submission, the runtime requires `exam.allow_review: true`. The browser displays post-submission assistance in graded question review. `why_wrong` is available only for a question marked incorrect by answer-key grading. It does not apply to unanswered or agent-scored questions. Candidates request explanations from the browser. A separate agent must claim and complete each request; the runtime does not call a model or generate explanations itself.

## Grading and timer

- **Answer key:** Submission grades the attempt immediately. Multi-select requires the exact set of correct IDs, in any order. There is no partial credit for a subset. An incorrect or unanswered question earns its configured points for that outcome.
- **Agent grading:** Submission sets `pending_grading`. No model runs automatically. A trusted agent must send one `{ "question_id": "…", "score": 0, "feedback": "…" }` per question, including unanswered questions. `feedback` is optional. Scores range from zero to each question's effective `correct_points`. The configured `incorrect_points` and `unanswered_points` must both be zero in this mode; the submitted score is used instead.
- **Totals:** Points support up to three decimal places. `correct_points` must be positive; other point values cannot be negative or exceed the effective `correct_points`. Maximum points is the sum of effective `correct_points`. Percent is earned points divided by maximum points, times 100. A score at or above `passing_percent` passes. The highest level threshold met determines the level, if any. Results include domain totals. `allow_review` controls candidate flags and per-question results, not navigation or trusted MCP access.
- **Deadline:** A session snapshots the exam and question order at start. The server sets `deadline_at` from the start time plus `duration_minutes`. Reloading or closing the browser does not pause or reset it. At or after the deadline, answers and flags are locked. Only saved responses count.
- **Timeout:** With auto-submit on, some session operations can finalize an expired attempt. The HTTP server checks at startup and about every five seconds. The MCP process also checks about once per second; live state reads themselves do not finalize an attempt. With neither process running, finalization waits until a check runs. With auto-submit off, the expired attempt stays `in_progress` with edits locked until the candidate submits it. A submission at or after the deadline records `timeout` and uses the deadline as its submission time.

## Local-only security

Use this on a trusted local machine, not as a public, multi-user, or proctored exam service. There are no user accounts or per-candidate permissions. Do not expose the HTTP server through a reverse proxy, port forward, or tunnel. The server binds to `127.0.0.1`, checks the request host and origin, and requires `X-Exam-Runtime: 1` and JSON for writes. These checks are not authentication.

Candidate session views omit answer keys. Candidate results can show them after grading if review is enabled. Live MCP state never includes keys or question definitions, and omits responses unless a tool caller explicitly asks for them. The explanation queue contains request summaries, not question context. `explanation_request_get` never returns keys for `hint` requests. It can return keys for `detailed` and `why_wrong` in answer-key exams, including `detailed` during an eligible practice or learning attempt. Agents should not put answers in hints or disclose private data in candidate-facing text.

A scope restricts which exams and sessions a credentialed MCP agent can access. It does not restrict a trusted agent's access to keys within that scope: `exam_get` returns the full definition, and `exam_get_results` can return keys even when candidate review is off. CLI `exam show`, direct SQLite access, and uncredentialed local operator tools can bypass these scope boundaries. A local process that can launch the MCP server with access to the same database can run it as an operator. Give MCP and database access only to trusted local operators and agents. Protect session URLs, tokens, and the database, including its SQLite sidecar files.

## MCP over stdio

For a step-by-step practice setup and a copyable agent prompt, see the [AI agent integration guide](ai-agent-integration.md). Build first with `npm run build`. Configure your client to launch the compiled server directly. Example for a client with an `mcpServers` configuration:

```json
{
  "mcpServers": {
    "exam-runtime": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/exam-simulator-mcp/packages/mcp/dist/main.js"],
      "env": {
        "EXAM_RUNTIME_DB_PATH": "/absolute/path/to/exam-runtime.sqlite3",
        "EXAM_RUNTIME_PORT": "3000",
        "EXAM_RUNTIME_AGENT_ID": "practice-demo",
        "EXAM_RUNTIME_AGENT_TOKEN": "<inject the token from secure storage>"
      }
    }
  }
}
```

Use the same database and port for the MCP, HTTP, and CLI processes. The MCP client starts its own server process over stdio. It does not start the HTTP server. Stdout is reserved for the protocol. Successful tool calls return `{ "data": ... }` in `structuredContent`, also serialized as text. Tool errors set `isError` and return `{ "error": { "code": ..., "message": ..., "details": [...] } }`.

### Provision a scope

1. Run `npm exec -- exam-runtime agent create <id>` against the shared database. IDs use 1 to 64 lowercase letters, digits, underscores, or hyphens and start with a letter or digit. `local` is reserved. Capture the token privately. The runtime stores only its hash and does not print the token again.
2. Set both `EXAM_RUNTIME_AGENT_ID` and `EXAM_RUNTIME_AGENT_TOKEN` in the MCP server process environment. Use your client's secret storage or another private means to inject the token. Do not commit it. Partial or invalid credentials fail with `FORBIDDEN` on tool calls.
3. Import with `npm exec -- exam-runtime exam import <file> --agent <id>`, then publish, or use `exam_create` from the credentialed MCP client. The session inherits the exam's scope at start. The CLI does not use the MCP credential to assign imports.

With both credential variables unset, MCP uses the trusted `local` operator profile. Original exam and grading tools retain operator-wide access. `exam_get_state`, both live resources, and the explanation tools still use the exact scope, even for the operator profile.

### Tools

| Tool | Arguments and role |
| --- | --- |
| `exam_create` | `{definition}`: make a draft from a complete exam JSON definition. Use returned `data.id` as `exam_id`. |
| `exam_update` | `{exam_id, definition}`: replace a draft definition. |
| `exam_publish` | `{exam_id}`: publish the draft. |
| `exam_list` | `{}` or optional `status` and `subject`: find exam summaries. |
| `exam_get` | `{exam_id}`: read the full definition, including any keys. |
| `exam_get_ui_url` | `{exam_id}`: get the published exam overview URL. Check `data.available` before sharing it; if false, read `data.message`. Does not start a session. |
| `exam_list_sessions` | `{exam_id?, status?, limit?}`: list recent attempts in the exact agent scope, with IDs, status, and timestamps only. Newest start time first. Default limit 20, maximum 100. |
| `exam_get_session` | `{session_id}`: read the attempt, candidate-safe questions, responses, and progress. |
| `exam_get_answers` | `{session_id}`: read the saved response rows by question ID. |
| `exam_get_results` | `{session_id}`: read status and trusted results. `data.result` is `null` until graded. |
| `exam_submit_grades` | `{session_id, grades}`: submit all per-question grades for a pending attempt. |
| `exam_get_state` | `{session_id, include_responses?}`: read the live state snapshot. `include_responses` defaults to `false`. |
| `explanation_requests_list` | `{status?, limit?}`: list request summaries in the current scope. `status` can be `pending`, `processing`, `completed`, `failed`, or `cancelled`. `limit` is an integer from 1 to 100 (default 100). |
| `explanation_request_get` | `{request_id}`: read the request and permitted question context. |
| `explanation_claim` | `{request_id}`: claim a pending request. Returns `claim_token` and `expires_at` (Unix milliseconds). |
| `explanation_submit` | `{request_id, claim_token, content}`: complete a request using the token from the claim. |

Typical flow: create or find an exam, publish it, and get its UI URL. The candidate starts and submits in the browser. Find the attempt ID with `exam_list_sessions` or copy it from `/sessions/<session-id>` or `/sessions/<session-id>/results`. Check results. If status is `pending_grading`, read the session and responses, submit all grades, then check results again. There is no MCP tool to start an attempt, write candidate answers, or submit the candidate attempt.

For assistance, list pending requests or read the pending resource. Claim a request, read its permitted context, and submit its content. The claim lasts two minutes. An expired claim returns to `pending` until the third expired claim, when it becomes `failed`. Competing workers can receive `CONFLICT`; refresh the queue instead of using another worker's claim. Keep claim tokens private.

`content` requires `summary` (1 to 500 characters) and `explanation` (1 to 12,000). It can include `learning_tip` (1 to 2,000) and `agent_metadata` (a JSON object up to 2,000 characters when serialized). The browser displays only the text fields, with basic emphasis and inline code. It does not render raw HTML, images, or Markdown links.

### Live resources and fallback

| Resource template name | URI | JSON snapshot |
| --- | --- | --- |
| `exam-session-state` | `exam://sessions/{session_id}/state` | Status, revision, timer, progress, current question ID, flags, and grading status. Never includes candidate responses. |
| `exam-explanations-pending` | `exam://agents/{agent_id}/explanations/pending` | `revision`, `pending_count`, and up to 100 pending request summaries for the current scope. Use `local` as the agent ID for the `local` scope. |

A modern client negotiates MCP `2026-07-28` and checks `resources.subscribe`. Register a handler for `notifications/resources/updated`, then call `subscriptions/listen` with the concrete URIs in `notifications.resourceSubscriptions` (`client.listen({ resourceSubscriptions: [...] })` with the v2 client SDK). Check that the server honored the requested URIs. The server omits unauthorized or unknown URIs. Read each honored URI with `resources/read` after subscribing, and read it again on notification. Apply the same subscribe-then-read sequence after reconnect. Reads return JSON as text in the resource `contents` array.

Each notification invalidates the snapshot for its URI. It is not a state delta or an event history. Multiple writes can produce one notification. The passing of time alone does not generate a timer tick notification. Use the snapshot deadline or read again as needed. The maintenance check publishes a state revision at timeout, even when auto-submit is off. A client without modern subscription support should poll `exam_get_state` and `explanation_requests_list` with `status: "pending"`. Do not use legacy `resources/subscribe` as a fallback. The example client polls about every two seconds when it does not negotiate modern subscriptions.

### Browser updates

The browser uses HTTP, not MCP. For explanations it fetches `GET /api/sessions/<session-id>/explanations` and opens an `EventSource` on the same path plus `/events` when assistance is available. An `explanations` SSE event tells the browser to fetch the current snapshot again; it does not carry explanation text. EventSource retries temporary interruptions, and the browser fetches on reconnect. While the stream is unavailable, the browser polls every five seconds. If the stream closes permanently, **Check for explanations** refreshes the snapshot and retries the stream. The server allows up to 64 simultaneous explanation streams. It does not use that stream to broadcast the countdown, answers, or grades. The pending-grading results page polls separately, about every 2.4 seconds (five seconds after a failed poll), and offers **Check for results**.

## Manual smoke tests

### Scoped practice and live updates

1. Build with `npm run build`. Use a fresh database for the demo, for example `export EXAM_RUNTIME_DB_PATH="$PWD/practice-demo.sqlite3"`, and use the same absolute path in every terminal. Start `npm exec -- exam-runtime serve` in one terminal. The commands below assume port `3000`.
2. In a second terminal, create the scope and import the demo. These commands capture the token without displaying it; run them without shell tracing. Use a fresh database or a new scope ID if `practice-demo` already exists.

   ```sh
   export EXAM_RUNTIME_AGENT_ID=practice-demo
   EXAM_RUNTIME_AGENT_TOKEN="$(node packages/cli/dist/main.js agent create "$EXAM_RUNTIME_AGENT_ID" | node -p 'JSON.parse(require("node:fs").readFileSync(0, "utf8")).token')"
   export EXAM_RUNTIME_AGENT_TOKEN
   npm exec -- exam-runtime exam import examples/practice-assistance.json --agent "$EXAM_RUNTIME_AGENT_ID"
   npm exec -- exam-runtime exam publish 'EXAM_ID'
   ```

   Replace `EXAM_ID` with the imported ID. Open `http://127.0.0.1:3000/exams/EXAM_ID` and start. Copy the session ID from `/sessions/<session-id>`.
3. In the credentialed terminal, run `node examples/explanation-subscription-client.ts 'SESSION_ID'` with that ID. The session ID is optional if you only want to watch the explanation queue. Verify the client subscribes to the pending and state URIs and prints an initial state. The client submits deterministic mock text. It does not call a model.
4. Answer the first question incorrectly, flag it, move to the next question, and verify the client reports changed state. Reload and verify that the timer has not reset and the question position, answer, and flag persist. Go back to the first question and select **Request Hint**. Verify that the mock explanation appears without reloading, then reload and verify it remains. Submit and verify the score and the **Why my answer was wrong** request option for the incorrect answer.
5. To check reconnect, stop the client before requesting a new eligible explanation. Verify that the browser shows it waiting, then restart the client and verify the waiting request completes from the initial queue snapshot. Press Ctrl+C when done and run `unset EXAM_RUNTIME_AGENT_ID EXAM_RUNTIME_AGENT_TOKEN` in the demo shell.

For automated checks, run `npm test`. The separate-process subscription, reconnect, scope, and SSE test can also run on its own: `npm run build:backend && npm exec -- vitest run tests/live-transport.test.ts`. With the demo client running and the browser at the practice exam overview, you can use `playwright-cli run-code --filename=tests/browser-practice-flow.js` to run the browser smoke flow instead of clicking through step 4. For that flow, start the example client without a session ID because the script starts its own attempt.

### Baseline grading

**Candidate, answer key:** With the built server running, import and publish the example:

```sh
npm exec -- exam-runtime exam import examples/aws-practice.json
npm exec -- exam-runtime exam publish 'EXAM_ID'
```

Replace `EXAM_ID` with the ID printed by import. From the local exam library, open **AWS Cloud Practice Exam** and start. Answer a question and flag it. Wait for **Changes saved**, reload, and verify the answer and flag persist and the timer continues. Submit and check the score, domain totals, and question review. The exam has 10 questions worth 12 points in total. `npm exec -- exam-runtime results <session-id>` should report the same score. For a short timeout check, import a copy with `duration_minutes` set to 1, publish it, and let a fresh attempt expire. Verify it submits saved answers and reports a timeout.

**Agent grading:** Connect an MCP client with both agent credential variables unset to use the local operator profile. Use `exam_create` with this JSON as `definition`, then call `exam_publish` and `exam_get_ui_url` with the returned exam ID:

```json
{
  "schema_version": "1.0",
  "exam": { "title": "Agent grading smoke test" },
  "grading": { "mode": "agent_graded", "correct_points": 2 },
  "questions": [
    { "id": "q1", "type": "free_text", "text": "What is one reason to test a backup restore?" }
  ]
}
```

Open the returned URL, start, answer, and submit. Verify that the browser shows grading in progress and `exam_get_results` reports `pending_grading`. Verify the response with `exam_get_answers`. To check the handoff, call `exam_submit_grades` with the session ID and `grades: [{"question_id":"q1","score":2,"feedback":"Smoke test score."}]`. Verify `graded`, 2/2 points, and feedback on the candidate results page.
