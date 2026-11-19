# Exam Runtime

Exam Runtime is a local exam simulator. An operator imports or creates a JSON exam, publishes it, and gives the candidate a local browser URL. The candidate takes a timed attempt in the browser. The runtime either grades it against an answer key or waits for a trusted agent to submit scores over MCP.

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
| `packages/mcp` | Stdio tools for trusted operators and grading agents |

## CLI

Use `npm exec -- exam-runtime` followed by a command:

| Command | Effect |
| --- | --- |
| `init` | Create or migrate the local database. |
| `serve [--port <port>]` | Serve the candidate API and built UI on `127.0.0.1`. |
| `exam import <file>` | Validate a JSON definition and import it as a draft with a new exam ID. |
| `exam list [--status draft\|published] [--subject <subject>]` | List exam summaries, with optional filters. |
| `exam show <exam-id>` | Print the full record, including answer keys. Trusted use only. |
| `exam publish <exam-id>` | Publish the exam so candidates can start attempts. Published definitions cannot be edited. |
| `exam start <exam-id> [--port <port>]` | Start the timer immediately and print the session URL. This does not launch the UI server. |
| `results <session-id>` | Show the attempt status or final score. |
| `mcp` | Run the MCP server over stdin and stdout. |

For a candidate who is not ready to start, share the exam overview URL (`/exams/<exam-id>`), not a URL from `exam start`. The timer starts when the candidate starts an attempt from the overview.

## Exam JSON

See [the AWS practice exam](examples/aws-practice.json) for a full answer-key example and [the source schema](packages/schemas/src/index.ts) for validation rules. Use `schema_version: "1.0"`. Unknown fields are rejected except for entries inside `metadata` maps.

| Object | Fields and defaults |
| --- | --- |
| Root | `schema_version`, `exam`, optional `grading`, and `questions` (1 to 500). |
| `exam` | Required `title`. Optional `description`, `instructions`, `subject` (`General`), `difficulty`, `mode` (`exam` only), `duration_minutes` (integer 1 to 1440, default 60), `shuffle_questions` (false), `allow_review` (true), `auto_submit_on_timeout` (true), and `metadata`. |
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

## Grading and timer

- **Answer key:** Submission grades the attempt immediately. Multi-select requires the exact set of correct IDs, in any order. There is no partial credit for a subset. An incorrect or unanswered question earns its configured points for that outcome.
- **Agent grading:** Submission sets `pending_grading`. No model runs automatically. A trusted agent must send one `{ "question_id": "…", "score": 0, "feedback": "…" }` per question, including unanswered questions. `feedback` is optional. Scores range from zero to each question's effective `correct_points`. The configured `incorrect_points` and `unanswered_points` must both be zero in this mode; the submitted score is used instead.
- **Totals:** Points support up to three decimal places. `correct_points` must be positive; other point values cannot be negative or exceed the effective `correct_points`. Maximum points is the sum of effective `correct_points`. Percent is earned points divided by maximum points, times 100. A score at or above `passing_percent` passes. The highest level threshold met determines the level, if any. Results include domain totals. `allow_review` controls candidate flags and per-question results, not navigation or trusted MCP access.
- **Deadline:** A session snapshots the exam and question order at start. The server sets `deadline_at` from the start time plus `duration_minutes`. Reloading or closing the browser does not pause or reset it. At or after the deadline, answers and flags are locked. Only saved responses count.
- **Timeout:** With auto-submit on, session access can finalize an expired attempt, and the running HTTP server checks for expired attempts at startup and about every five seconds. If the server is off, finalization waits until a check runs. With auto-submit off, the expired attempt stays `in_progress` with edits locked until the candidate submits it. A submission at or after the deadline records `timeout` and uses the deadline as its submission time.

## Local-only security

Use this on a trusted local machine, not as a public, multi-user, or proctored exam service. There are no user accounts or per-candidate permissions. Do not expose the HTTP server through a reverse proxy, port forward, or tunnel. The server binds to `127.0.0.1`, checks the request host and origin, and requires `X-Exam-Runtime: 1` and JSON for writes. These checks are not authentication.

Candidate session views omit answer keys, but candidate results can show them after grading when review is enabled. CLI `exam show`, MCP exam and result tools, and direct access to SQLite can expose keys or private responses. Give MCP and database access only to trusted local operators and agents. Protect session URLs and the database, including its SQLite sidecar files.

## MCP over stdio

Build first with `npm run build`. Configure your client to launch the compiled server directly. Example for a client with an `mcpServers` configuration:

```json
{
  "mcpServers": {
    "exam-runtime": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/exam-simulator-mcp/packages/mcp/dist/main.js"],
      "env": {
        "EXAM_RUNTIME_DB_PATH": "/absolute/path/to/exam-runtime.sqlite3",
        "EXAM_RUNTIME_PORT": "3000"
      }
    }
  }
}
```

Use the same database path and port for `exam-runtime serve` and CLI commands. The MCP process does not start the HTTP server. The client owns the MCP process; stdout is reserved for the protocol. Successful calls return `{ "data": ... }` in `structuredContent`, also serialized as text. Tool errors set `isError` and return `{ "error": { "code": ..., "message": ..., "details": [...] } }`.

| Tool | Arguments and role |
| --- | --- |
| `exam_create` | `{definition}`: make a draft from a complete exam JSON definition. Use returned `data.id` as `exam_id`. |
| `exam_update` | `{exam_id, definition}`: replace a draft definition. |
| `exam_publish` | `{exam_id}`: publish the draft. |
| `exam_list` | `{}` or optional `status` and `subject`: find exam summaries. |
| `exam_get` | `{exam_id}`: read the full definition, including any keys. |
| `exam_get_ui_url` | `{exam_id}`: get the published exam overview URL. Check `data.available` before sharing it; if false, read `data.message`. Does not start a session. |
| `exam_get_session` | `{session_id}`: read the attempt, questions, and progress. |
| `exam_get_answers` | `{session_id}`: read the saved response rows by question ID. |
| `exam_get_results` | `{session_id}`: read status and results. `data.result` is `null` until graded. |
| `exam_submit_grades` | `{session_id, grades}`: submit all per-question grades for a pending attempt. |

Typical flow: create or find an exam, publish it, and get its UI URL. The candidate starts and submits in the browser. Get the session ID from `/sessions/<session-id>` or `/sessions/<session-id>/results`. Check results. If status is `pending_grading`, read the session and responses, submit all grades, then check results again. There is no MCP tool to start an attempt, write candidate answers, or submit the candidate attempt.

## Manual smoke tests

**Candidate, answer key:** With the built server running, import and publish the example:

```sh
npm exec -- exam-runtime exam import examples/aws-practice.json
npm exec -- exam-runtime exam publish 'EXAM_ID'
```

Replace `EXAM_ID` with the ID printed by import. From the local exam library, open **AWS Cloud Practice Exam** and start. Answer a question and flag it. Wait for **Changes saved**, reload, and verify the answer and flag persist and the timer continues. Submit and check the score, domain totals, and question review. The exam has 10 questions worth 12 points in total. `npm exec -- exam-runtime results <session-id>` should report the same score. For a short timeout check, import a copy with `duration_minutes` set to 1, publish it, and let a fresh attempt expire. Verify it submits saved answers and reports a timeout.

**Agent grading:** Use `exam_create` with this JSON as `definition`, then call `exam_publish` and `exam_get_ui_url` with the returned exam ID:

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
