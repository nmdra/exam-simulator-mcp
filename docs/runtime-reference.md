# Exam Runtime reference

For a short setup procedure, see the [project README](../README.md). For MCP host configuration and agent prompts, see the [AI agent integration guide](ai-agent-integration.md).

## Install and run

Use Node.js 26 LTS. The repository sets the version to `26.13.1` in `.nvmrc`. The required version range is `>=26.13.1 <27`. Run these commands from the repository root:

```sh
nvm install && nvm use  # if you use nvm
npm ci
npm run build
npm test
npm exec -- exam-runtime --help
npm exec -- exam-runtime init
npm exec -- exam-runtime serve
```

Open <http://127.0.0.1:3000/>. `npm run build` builds the TypeScript packages and browser UI. `npm test` builds the backend and runs Vitest. `npm run typecheck` checks the TypeScript project. After a backend build, `npm run test:watch` starts Vitest in watch mode.

For development, run `npm run dev:api` and `npm run dev:web` in separate terminals. Open <http://127.0.0.1:5173/>. Vite forwards `/api` requests to the backend. Restart `dev:api` after you edit the backend. If you change the API port, set `EXAM_RUNTIME_PORT` to the same value in both terminals. The CLI and MCP check UI links against the built UI at the backend port. They do not check the Vite development URL.

`better-sqlite3` is a native dependency. If there is no prebuilt binary for your Node version and platform, install the local `node-gyp` prerequisites. Install Python 3 and a C/C++ toolchain. On Linux, use `make` and a compiler. On macOS, use Xcode Command Line Tools. On Windows, use Visual Studio Build Tools with Desktop development with C++. To force a build from source, set `npm_config_build_from_source=true` in the environment and run `npm ci` again.

### Run the npm package with npx

From the repository root, run `npm ci`. Then run `npm run pack:npm`. The build puts the CLI, browser UI, and stdio server in `dist/npm/exam-runtime-mcp-VERSION.tgz`. You can use the tarball outside the repository. npm installs the runtime dependencies.

```sh
# Use the absolute tarball path when launching from a different directory.
version=$(node -p 'require("./package.json").version')
npx --yes --package="$PWD/dist/npm/exam-runtime-mcp-$version.tgz" exam-runtime --help
```

In the stdio configuration of your host, use `exam-runtime mcp` with the same `npx --package=…` command. See the [AI agent integration guide](ai-agent-integration.md#2-register-the-mcp-server-in-your-agent-host). To use the published version instead of a local tarball, run `npx --yes exam-runtime-mcp mcp`.

## Data and port

The CLI, HTTP server, and MCP server must use the same SQLite database. Exam Runtime selects the database path in this order:

1. `EXAM_RUNTIME_DB_PATH`, a complete database file path.
2. `EXAM_RUNTIME_DATA_DIR/exam-runtime.sqlite3`.
3. `exam-runtime/exam-runtime.sqlite3` in the platform data directory. If you set an absolute `XDG_DATA_HOME`, Exam Runtime uses that directory. Otherwise, Exam Runtime uses `~/Library/Application Support` on macOS, `%LOCALAPPDATA%` (or `~/AppData/Local`) on Windows, or `~/.local/share` elsewhere.

Use absolute paths for overrides. Absolute paths work from any process working directory. `exam-runtime init` prints the selected path. The default HTTP port is `3000`. Set `EXAM_RUNTIME_PORT` in each process that serves or generates browser URLs. To override the port for one `serve` or `exam start` command, use `--port`.

## Architecture

| Path | Role |
| --- | --- |
| `packages/schemas` | Zod schemas for exam definitions, answers, and grades |
| `packages/storage` | SQLite storage and migrations with `better-sqlite3` |
| `packages/core` | Shared exam lifecycle, session snapshots, timer enforcement, and grading |
| `packages/server` | Fastify server for the candidate API and static browser UI |
| `apps/web` | React candidate UI for browsing, taking, and reviewing exams |
| `packages/cli` | Local operator commands and server entry points |
| `packages/mcp` | Stdio tools and resources for trusted operators and agents |

## CLI

Use `npm exec -- exam-runtime` followed by a command:

| Command | Effect |
| --- | --- |
| `init` | Create or migrate the local database. |
| `serve [--port <port>]` | Serve the candidate API and built UI on `127.0.0.1`. |
| `agent create <id>` | Create a local MCP agent scope. Print its credential once as JSON (`agent_id` and `token`). |
| `exam import <file> [--agent <id>]` | Validate a JSON definition. Import the definition as a draft with a new exam ID. Assign the draft to an existing agent scope, or to `local` by default. |
| `exam list [--status draft\|published] [--subject <subject>]` | List exam summaries. Filters are optional. |
| `exam show <exam-id>` | Print the full record, including answer keys. For trusted use only. |
| `exam publish <exam-id>` | Publish the exam so candidates can start attempts. You cannot edit a published definition. |
| `exam start <exam-id> [--port <port>]` | Start the timer immediately. Print the session URL. This command does not start the UI server. |
| `results <session-id>` | Show the attempt status or final score. |
| `mcp` | Run the MCP server over stdin and stdout. |

If the candidate is not ready to start, share the exam overview URL (`/exams/<exam-id>`). Do not use a URL from `exam start` for this purpose. The timer starts when the candidate starts an attempt from the exam overview.

## Exam JSON

For a complete example with an answer key, see [the AWS practice exam](../examples/aws-practice.json). For validation rules, see [the source schema](../packages/schemas/src/index.ts). Use `schema_version: "1.0"`. Exam Runtime rejects unknown fields except for entries in `metadata` maps.

| Object | Fields and defaults |
| --- | --- |
| Root | `schema_version`, `exam`, optional `grading`, optional `assistance`, and `questions` (1 to 500). |
| `exam` | Required `title`. Optional `description`, `instructions`, `subject` (`General`), `difficulty`, `mode` (`exam` by default, `practice`, or `learning`), `duration_minutes` (integer 1 to 1440, default 60), `shuffle_questions` (false), `allow_review` (true), `auto_submit_on_timeout` (true), and `metadata`. |
| `grading` | `mode` (`answer_key` by default or `agent_graded`), `correct_points` (1), `incorrect_points` (0), `unanswered_points` (0), `passing_percent` (70), and `levels` (empty by default). Each level is `{ "name": "Proficient", "min_percent": 70 }`. Names and thresholds must each be unique. |
| Each question | Required `id`, `type`, and `text`. Optional `domain` (`General`), `difficulty`, `options`, `correct_answers`, `points`, and `metadata`. `points` is a map of per-question overrides for `correct_points`, `incorrect_points`, and `unanswered_points`. |

Question IDs must be unique within an exam. Option IDs must be unique within a question. Question IDs and option IDs use 1 to 80 letters, digits, underscores, or hyphens. Exam Runtime generates UUIDs for exams and sessions. An option is an object with `id` and `text`. Select questions need 2 to 30 options. Answer keys use option IDs, not the option text.

| Question `type` | Definition | Candidate response value |
| --- | --- | --- |
| `single_select` | `options` and one key ID in `correct_answers` | One option ID string |
| `multi_select` | `options` and one or more unique key IDs in `correct_answers` | Array of unique option IDs |
| `true_false` | No `options`; one string key, `"true"` or `"false"`, in `correct_answers` | Boolean `true` or `false` |
| `free_text` | Only in `agent_graded`; omit `options` and `correct_answers` | Text string |

In `answer_key` mode, answer keys are required for select and true/false questions. In `agent_graded` mode, these keys are optional. `null` clears a response. Exam Runtime also counts an empty selection or a free-text response with only whitespace as unanswered.

### Assistance settings

Assistance is off if you omit `assistance` or set `enabled` to `false`. With `"assistance": { "enabled": true }`, all other settings use these defaults:

| Field | Values and default |
| --- | --- |
| `enabled` | Boolean, default `false`. |
| `exam_mode` | `disabled` or `after_submission` (default). Never available during an exam-mode attempt. |
| `practice_mode`, `learning_mode` | `disabled`, `after_submission`, or `on_request` (default for both). `on_request` allows eligible requests before the deadline and in review. |
| `allowed_types` | Array of 1 to 3 unique values from `hint`, `detailed`, and `why_wrong`. Default: all three. |

After submission, Exam Runtime requires `exam.allow_review: true`. The browser shows assistance after submission in the graded question review. `why_wrong` is available only for a question that answer-key grading marked incorrect. This explanation type does not apply to unanswered questions or questions that an agent scored. Candidates request explanations in the browser. A separate agent must claim and complete each request. Exam Runtime does not call a model or generate explanations.

## Grading and timer

- **Answer key:** Exam Runtime grades the attempt immediately after submission. A multi-select response must contain exactly the correct IDs. The order does not matter. Exam Runtime gives no partial credit for a subset. An incorrect or unanswered question earns the points for that outcome in the configuration.
- **Agent grading:** Submission sets the status to `pending_grading`. No model runs automatically. A trusted agent must send one `{ "question_id": "…", "score": 0, "feedback": "…" }` per question. Include unanswered questions. `feedback` is optional. Scores range from zero to each question's effective `correct_points`. In this mode, the configured `incorrect_points` and `unanswered_points` must both be zero. Exam Runtime uses the submitted score instead.
- **Totals:** Points support up to three decimal places. `correct_points` must be positive. Other point values cannot be negative or more than the effective `correct_points`. Maximum points is the sum of the effective `correct_points`. Percent is earned points divided by maximum points, times 100. A score at or above `passing_percent` passes. If the score meets a level threshold, the highest threshold met determines the level. Results include totals for each domain. `allow_review` controls candidate flags and results for each question. It does not control navigation or trusted MCP access.
- **Deadline:** At the start of a session, Exam Runtime records a snapshot of the exam and question order. The server sets `deadline_at` to the start time plus `duration_minutes`. Reloading or closing the browser does not pause or reset the timer. At or after the deadline, you cannot change answers or flags. Only saved responses count.
- **Timeout:** If auto-submit is on, some session operations can finalize an expired attempt. The HTTP server checks at startup and about every five seconds. The MCP server also checks about once per second. Reading live state does not finalize an attempt. If neither server is running, finalization waits until a check runs. If auto-submit is off, the expired attempt stays `in_progress` until the candidate submits it. The candidate cannot edit the attempt during this time. For a submission at or after the deadline, Exam Runtime records `timeout` and uses the deadline as the submission time.

## Local-only security

Use Exam Runtime on a trusted local machine. Do not use Exam Runtime as a public, multi-user, or proctored exam service. There are no user accounts or permissions for individual candidates. Do not expose the HTTP server through a reverse proxy, port forward, or tunnel. The HTTP server binds to `127.0.0.1` and checks the request host and origin. The server requires `X-Exam-Runtime: 1` and JSON for writes. These checks are not authentication.

Candidate session views do not show answer keys. If review is enabled, candidate results can show answer keys after grading. Live MCP state never includes answer keys or question definitions. It includes responses only if a tool caller explicitly requests them. The explanation queue contains request summaries. It does not contain question context. `explanation_request_get` never returns answer keys for `hint` requests. It can return answer keys for `detailed` and `why_wrong` in exams with answer-key grading. This includes `detailed` during an eligible practice or learning attempt. Agents should not put answers in hints or disclose private data in text for candidates.

A scope limits which exams and sessions an MCP agent with credentials can access. It does not limit a trusted agent's access to answer keys within that scope. `exam_get` returns the complete definition. `exam_get_results` can return answer keys even if candidate review is off. The CLI command `exam show`, direct SQLite access, and local operator tools without credentials can bypass these scope limits. A local process can run the MCP server as an operator if the process can start the MCP server with access to the same database. Give MCP and database access only to trusted local operators and agents. Protect session URLs, tokens, and the database, including its SQLite sidecar files.

## MCP over stdio

For the practice setup procedure and an agent prompt you can copy, see the [AI agent integration guide](ai-agent-integration.md). First, run `npm run build`. Configure the MCP client to start the compiled server directly. This example uses an `mcpServers` configuration:

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

Use the same database and port for the MCP server, HTTP server, and CLI. The MCP client starts its own server process over stdio. The MCP client does not start the HTTP server. Stdout is for MCP protocol messages only. A successful tool call returns `{ "data": ... }` in `structuredContent` and also returns the same data as text. A tool error sets `isError` and returns `{ "error": { "code": ..., "message": ..., "details": [...] } }`.

### Provision a scope

1. Run `npm exec -- exam-runtime agent create <id>` with the shared database. An ID uses 1 to 64 lowercase letters, digits, underscores, or hyphens. An ID must start with a letter or digit. `local` is reserved. Record the token privately. Exam Runtime stores only the token hash and does not print the token again.
2. Set both `EXAM_RUNTIME_AGENT_ID` and `EXAM_RUNTIME_AGENT_TOKEN` in the MCP server process environment. Use the MCP client's secret storage or another private method to supply the token. Do not commit the token. If the credentials are incomplete or invalid, tool calls fail with `FORBIDDEN`.
3. To use the CLI, import the exam with `npm exec -- exam-runtime exam import <file> --agent <id>`. Then publish the exam. Alternatively, use `exam_create` from an MCP client with credentials. When a session starts, it uses the scope of the exam. The CLI does not use the MCP credential to assign imported exams to a scope.

If you leave both credential variables unset, the MCP server uses the trusted `local` operator profile. The original exam and grading tools keep operator-wide access. `exam_get_state`, both live resources, and the explanation tools use the exact scope, even for the operator profile.

### Tools

| Tool | Arguments and role |
| --- | --- |
| `exam_create` | `{definition}`: make a draft from a complete exam JSON definition. Use returned `data.id` as `exam_id`. |
| `exam_update` | `{exam_id, definition}`: replace a draft definition. |
| `exam_publish` | `{exam_id}`: publish the draft. |
| `exam_list` | `{}` or optional `status` and `subject`: find exam summaries. |
| `exam_get` | `{exam_id}`: read the full definition, including any keys. |
| `exam_get_ui_url` | `{exam_id}`: get the published exam overview URL. Check `data.available` before you share the URL. If the value is false, read `data.message`. This tool does not start a session. |
| `exam_list_sessions` | `{exam_id?, status?, limit?}`: list recent attempts in the exact agent scope. Includes only IDs, status, and timestamps. The newest start time is first. The default limit is 20. The maximum limit is 100. |
| `exam_get_session` | `{session_id}`: read the attempt, candidate-safe questions, responses, and progress. |
| `exam_get_answers` | `{session_id}`: read the saved response rows by question ID. |
| `exam_get_results` | `{session_id}`: read status and trusted results. `data.result` is `null` until graded. |
| `exam_submit_grades` | `{session_id, grades}`: submit all per-question grades for a pending attempt. |
| `exam_get_state` | `{session_id, include_responses?}`: read the live state snapshot. `include_responses` defaults to `false`. |
| `explanation_requests_list` | `{status?, limit?}`: list request summaries in the current scope. `status` can be `pending`, `processing`, `completed`, `failed`, or `cancelled`. `limit` is an integer from 1 to 100 (default 100). |
| `explanation_request_get` | `{request_id}`: read the request and permitted question context. |
| `explanation_claim` | `{request_id}`: claim a pending request. Returns `claim_token` and `expires_at` (Unix milliseconds). |
| `explanation_submit` | `{request_id, claim_token, content}`: complete a request using the token from the claim. |

In a typical workflow, create or find an exam. Publish the exam and get its UI URL. The candidate starts the attempt and submits it in the browser. Find the attempt ID with `exam_list_sessions` or copy the ID from `/sessions/<session-id>` or `/sessions/<session-id>/results`. Check the results. If the status is `pending_grading`, read the session and responses. Submit all grades. Then check the results again. There is no MCP tool to start an attempt, write candidate answers, or submit the candidate attempt.

For assistance, list pending requests or read the pending resource. Claim a request. Read the permitted context for the request. Submit the content for the request. The claim lasts two minutes. When a claim expires, the request returns to `pending` unless this is the third expired claim. After the third expired claim, the request changes to `failed`. Competing workers can receive `CONFLICT`. Refresh the queue instead of using the claim of a different worker. Keep claim tokens private.

`content` requires `summary` (1 to 500 characters) and `explanation` (1 to 12,000). The content can include `learning_tip` (1 to 2,000) and `agent_metadata` (a JSON object up to 2,000 characters when serialized). The browser shows only the text fields, with basic emphasis and inline code. The browser does not render raw HTML, images, or Markdown links.

### Live resources and fallback

| Resource template name | URI | JSON snapshot |
| --- | --- | --- |
| `exam-session-state` | `exam://sessions/{session_id}/state` | Status, revision, timer, progress, current question ID, flags, and grading status. Never includes candidate responses. |
| `exam-explanations-pending` | `exam://agents/{agent_id}/explanations/pending` | `revision`, `pending_count`, and up to 100 pending request summaries for the current scope. Use `local` as the agent ID for the `local` scope. |

A modern client negotiates MCP `2026-07-28` and checks `resources.subscribe`. Register a handler for `notifications/resources/updated`. Then call `subscriptions/listen` with the concrete URIs in `notifications.resourceSubscriptions` (`client.listen({ resourceSubscriptions: [...] })` with the v2 client SDK). Check that the MCP server accepted the requested URIs. The MCP server omits unauthorized or unknown URIs. After you subscribe, read each accepted URI with `resources/read`. When you receive a notification, read that URI again. After you reconnect, subscribe first and read the resources again. Each read returns JSON as text in the resource `contents` array.

Each notification invalidates the snapshot for its URI. The notification is not a state delta or an event history. More than one write can produce one notification. The passing of time alone does not cause a timer tick notification. Use the deadline in the snapshot or read the resource again as necessary. The maintenance check publishes a state revision at timeout, even if auto-submit is off. If a client does not support modern subscriptions, the client should poll `exam_get_state` and `explanation_requests_list` with `status: "pending"`. Do not use legacy `resources/subscribe` as a fallback. If the example client does not negotiate modern subscriptions, it polls about every two seconds.

### Browser updates

The browser uses HTTP, not MCP. For explanations, the browser uses `GET /api/sessions/<session-id>/explanations`. When assistance is available, the browser opens an `EventSource` on the same path with `/events` added. An `explanations` SSE event tells the browser to get the current snapshot again. The event does not contain explanation text. EventSource tries to reconnect after a temporary interruption. When EventSource reconnects, the browser gets the snapshot again. While the stream is unavailable, the browser polls every five seconds. If the stream closes permanently, select **Check for explanations** to refresh the snapshot and try the stream again. The server permits up to 64 explanation streams at the same time. The server does not use the explanation stream to send the countdown, answers, or grades. The results page for an attempt that is pending grading polls separately. It polls about every 2.4 seconds (five seconds after a failed poll). It also provides **Check for results**.

## Manual smoke tests

### Scoped practice and live updates

1. Run `npm run build`. Use a new database for the example. For example, use `export EXAM_RUNTIME_DB_PATH="$PWD/practice-demo.sqlite3"`. Use the same absolute path in each terminal. In one terminal, start `npm exec -- exam-runtime serve`. The commands below use port `3000`.
2. In a second terminal, create the scope and import the example exam. The commands collect the token without displaying it. Run the commands without shell tracing. If `practice-demo` already exists, use a new database or a new scope ID.

   ```sh
   export EXAM_RUNTIME_AGENT_ID=practice-demo
   EXAM_RUNTIME_AGENT_TOKEN="$(node packages/cli/dist/main.js agent create "$EXAM_RUNTIME_AGENT_ID" | node -p 'JSON.parse(require("node:fs").readFileSync(0, "utf8")).token')"
   export EXAM_RUNTIME_AGENT_TOKEN
   npm exec -- exam-runtime exam import examples/practice-assistance.json --agent "$EXAM_RUNTIME_AGENT_ID"
   npm exec -- exam-runtime exam publish 'EXAM_ID'
   ```

   Replace `EXAM_ID` with the ID from the import command. Open `http://127.0.0.1:3000/exams/EXAM_ID`. Start the attempt. Copy the session ID from `/sessions/<session-id>`.
3. In the terminal with the agent credentials, run `node examples/explanation-subscription-client.ts 'SESSION_ID'` with the session ID. If you only need to monitor the explanation queue, the session ID is optional. Check that the client subscribes to the pending and state URIs. Check that the client prints an initial state. The client submits deterministic mock text. It does not call a model.
4. Answer the first question incorrectly. Flag the question. Go to the next question. Check that the client reports a state change. Reload the page. Check that the timer did not reset and that the question position, answer, and flag did not change. Return to the first question. Select **Request Hint**. Check that the mock explanation appears without a reload. Reload the page. Check that the explanation is still there. Submit the attempt. Check the score and the **Why my answer was wrong** request option for the incorrect answer.
5. To check reconnection, stop the client before you request a new eligible explanation. Check that the browser shows that the request is waiting. Restart the client. Check that the client completes the waiting request from the initial queue snapshot. When you finish, press Ctrl+C. Run `unset EXAM_RUNTIME_AGENT_ID EXAM_RUNTIME_AGENT_TOKEN` in the example shell.

For automated checks, run `npm test`. To run the separate-process subscription, reconnection, scope, and SSE test on its own, use `npm run build:backend && npm exec -- vitest run tests/live-transport.test.ts`. To use `playwright-cli run-code --filename=tests/browser-practice-flow.js` instead of the manual steps in step 4, run the example client and open the practice exam overview in the browser. Start the example client without a session ID for this test. The script starts its own attempt.

### Baseline grading

**Candidate, answer key:** Make sure the built server is running. Then import and publish the example:

```sh
npm exec -- exam-runtime exam import examples/aws-practice.json
npm exec -- exam-runtime exam publish 'EXAM_ID'
```

Replace `EXAM_ID` with the ID from the import command. Open **AWS Cloud Practice Exam** in the local exam library. Start the attempt. Answer a question. Flag the question. Wait for **Changes saved**. Reload the page. Check that the answer and flag are still there and that the timer continues. Submit the attempt. Check the score, domain totals, and question review. The exam has 10 questions that are worth 12 points in total. `npm exec -- exam-runtime results <session-id>` should report the same score. For a short timeout check, import a copy with `duration_minutes` set to 1. Publish the copy. Start a new attempt and let it expire. Check that Exam Runtime submits the saved answers and reports a timeout.

**Agent grading:** To use the local operator profile, leave both agent credential variables unset when you connect the MCP client. Use `exam_create` with this JSON as `definition`. Then use the returned exam ID to call `exam_publish` and `exam_get_ui_url`:

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

Open the returned URL. Start the attempt. Answer the question. Submit the attempt. Check that the browser shows grading in progress and that `exam_get_results` reports `pending_grading`. Use `exam_get_answers` to check the response. To test grade submission, call `exam_submit_grades` with the session ID and `grades: [{"question_id":"q1","score":2,"feedback":"Smoke test score."}]`. Check for `graded`, 2/2 points, and feedback on the candidate results page.
