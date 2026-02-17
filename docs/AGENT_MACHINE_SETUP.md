# Agent Machine Setup (Required)

This is the missing piece that ensures messages land in the correct local session.

## What runs on each agent machine

Run the example bridge service in:

`examples/agent-bridge-node/`

Responsibilities:
1. Receive router callback webhook (`POST /router/events`)
2. Validate callback signature (optional but recommended)
3. Resolve `router sessionKey -> local OpenClaw sessionKey`
4. Append event text into the correct local OpenClaw session
5. Publish outbound agent responses back to router

## Environment

Copy `.env.example` and configure:

- `BRIDGE_AGENT_ID` — your agent id used in router registration
- `ROUTER_BASE_URL` — router base URL
- `ROUTER_CALLBACK_SECRET` — same secret used at registration (for HMAC verification)
- `OPENCLAW_APPEND_URL` — local endpoint that appends text into your OpenClaw session runtime
- `OPENCLAW_APPEND_TOKEN` — optional auth token for local append endpoint

## Run

```bash
cd examples/agent-bridge-node
npm install
cp .env.example .env
npm run dev
```

## Register with router

Use bridge callback URL:

```json
{
  "agentId": "agent-alpha",
  "displayName": "Alpha Planner",
  "callbackUrl": "https://agent-alpha.example.com/router/events",
  "callbackSecret": "same-shared-secret",
  "requestedSessionKeys": ["telegram:-100:topic-98"]
}
```

## Session correctness

Bridge persists mapping in `.data/session-map.json`:

- key: router `sessionKey`
- value: local OpenClaw session key

When callback arrives, bridge resolves/creates mapping and forwards to that exact local session.

## Outbound from local agent to router

Bridge provides `POST /agent/outbound`:

```json
{
  "localSessionKey": "agent-alpha::telegram:-100:topic-98",
  "text": "response text",
  "traceId": "optional"
}
```

Bridge maps local session back to router session and publishes to `/mcp/events/publish`.

## Note on OpenClaw integration

`OPENCLAW_APPEND_URL` should be implemented by your local agent runtime wrapper.
It only needs to accept:

```json
{
  "sessionKey": "...",
  "message": "...",
  "metadata": { ... }
}
```

and append/send it into the matching OpenClaw session.
