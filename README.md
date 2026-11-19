# Exam Runtime

Use Exam Runtime to practice with an AI agent. The agent creates and publishes a practice exam through MCP. Take the exam in the browser UI. You do not need to answer questions in chat or ask the agent to build a new web page for each exam. After you finish, the agent can read your results, explain your mistakes, and create a follow-up quiz on your weakest topics.

## Get started

Use Node.js `26.13.1`. Follow the [AI agent integration guide](docs/ai-agent-integration.md). Start the browser UI, set up the agent scope, and connect over **MCP stdio**.

The MCP host launches this command:

```sh
npx --yes exam-runtime-mcp mcp
```

Then ask your agent:

> Create and publish a 10-question practice exam on a topic I am studying. Include recall and scenario questions. Send me the browser link. Do not show the answers. After I submit, use my results to explain my mistakes and create a short follow-up quiz on my weakest topics.

The browser saves your answers, flags, and progress. Exam Runtime can grade a submitted attempt with an answer key. An agent can also grade a submitted attempt. If the practice session permits hints, request a hint in the browser.

Exam Runtime runs locally and does not call a model. Your MCP host controls when the agent runs and what it sends to a model provider.

[Integration guide](docs/ai-agent-integration.md) · [Runtime and tool reference](docs/runtime-reference.md) · [Release workflow](docs/releasing.md)
