# OpenClaw Context Router

Standalone service for strict context/session routing across multi-human, multi-agent, multi-topic workflows.

## Why

OpenClaw with multiple agents needs deterministic routing and append behavior:
- one topic/thread maps to one `sessionKey`
- no accidental cross-session bleed
- safe handling of intentional loops while slowing error loops

## Key Design Decisions

1. Agent-originated events are **enabled by default**.
2. Intentional loops are allowed.
3. Error loops are mitigated by:
   - rate cap: max loop events per duration (`LOOP_MAX_PER_MINUTE`, default 6)
   - LLM decision per message to classify repetition as error loop
4. Error loops are **delayed**, not dropped.

## Quickstart

```bash
npm install
cp .env.example .env
npm run dev
```

Server runs on `http://localhost:8787` by default.

## Endpoints

- `POST /admin/whitelist/agent`
- `POST /mcp/events/publish`
- `GET /mcp/sessions/:sessionKey/events?agentId=...`
- `GET /health`

See `docs/API.md` and `docs/ARCHITECTURE.md`.

## Notes

- Current implementation uses in-memory store for fast iteration.
- Replace with durable DB/stream (Postgres + Redis/Kafka/NATS) for production.
- LLM loop decision uses OpenAI-compatible chat API when `OPENAI_API_KEY` is set.
