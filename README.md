# Exam Runtime

Give your AI agent a practice tool instead of asking it to quiz you in chat or build a new web page each time. The agent creates and publishes a question set through MCP. You take it in a reusable browser UI. Your agent can then read your results, explain what you missed, and create a follow-up set that targets those gaps.

## Get started

Use Node.js `26.13.1`. Follow the [AI agent integration guide](docs/ai-agent-integration.md) to start the browser UI, provision a scoped agent, and connect over **MCP stdio**. Both processes must use the same local SQLite database.

The MCP host launches this command:

```sh
npx --yes exam-runtime-mcp@0.1.0 mcp
```

Then ask your agent:

> Create and publish a 10-question practice exam on a topic I'm studying. Mix recall and scenario questions. Send me the browser link without revealing the answers. After I submit, use my results to explain what I missed and make a short follow-up quiz on my weakest topics.

The browser saves answers, flags, and progress. Exams can grade with an answer key or send a submitted attempt to an agent for grading. In eligible practice sessions, you can also request a hint from the browser.

Exam Runtime runs locally and does not call a model. Your MCP host controls when the agent runs and what it sends to a model provider.

[Integration guide](docs/ai-agent-integration.md) · [Runtime and tool reference](docs/runtime-reference.md) · [Release workflow](docs/releasing.md)
