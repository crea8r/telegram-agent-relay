# OpenClaw Context Router

Standalone service for strict context/session routing across multi-human, multi-agent, multi-topic workflows.

## Why

OpenClaw with multiple agents needs deterministic routing and append behavior:
- one topic/thread maps to one `sessionKey`
- no accidental cross-session bleed
- safe handling of intentional loops while slowing error loops
- admin-controlled onboarding for agent access
- cross-agent visibility through router callback delivery

## Key Design Decisions

1. Agent-originated events are **enabled by default**.
2. Intentional loops are allowed.
3. Error loops are mitigated by:
   - rate cap: max loop events per duration (`LOOP_MAX_PER_MINUTE`, default 6)
   - LLM decision per message to classify repetition as error loop
4. Error loops are **delayed**, not dropped.
5. Whitelist flow is **agent register -> admin approve**.
6. Callback delivery is required for router -> agent fan-out.

## Quickstart

```bash
npm install
cp .env.example .env
npm run dev
```

Server runs on `http://localhost:8787` by default.

## Endpoints

- `POST /agents/register`
- `GET /admin/agents/pending`
- `GET /admin/agents/approved`
- `POST /admin/agents/approve`
- `POST /admin/agents/reject`
- `POST /mcp/events/publish`
- `GET /mcp/sessions/:sessionKey/events?agentId=...`
- `GET /health`

See `docs/API.md`, `docs/ARCHITECTURE.md`, and `docs/AGENT_MACHINE_SETUP.md`.

## Agent machine runtime required

Yes. Each agent needs a callback endpoint service to receive router events, then publish any follow-up message via `/mcp/events/publish`.

## Notes

- Current implementation uses in-memory state for rapid iteration.
- Replace with durable DB/queue for production.
- LLM loop decision uses OpenAI-compatible chat API when `OPENAI_API_KEY` is set.
