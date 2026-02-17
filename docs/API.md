# API

## Agent onboarding flow (required)

### POST /agents/register

Agent requests access and MUST provide callback endpoint for router push delivery.

Request:
```json
{
  "agentId": "agent-alpha",
  "displayName": "Alpha Planner",
  "callbackUrl": "https://agent-alpha.example.com/router/events",
  "callbackSecret": "agent-shared-secret",
  "requestedSessionKeys": ["telegram:-100:topic-98"]
}
```

Response:
```json
{
  "ok": true,
  "status": "pending",
  "message": "agent registered; waiting for admin approval"
}
```

### GET /admin/agents/pending

List pending agent registrations.

### GET /admin/agents/approved

List approved agents and callback metadata.

### POST /admin/agents/approve

Admin approves an agent and grants session access.

Request:
```json
{
  "agentId": "agent-alpha",
  "sessionKeys": ["telegram:-100:topic-98"]
}
```

### POST /admin/agents/reject

Admin rejects an agent registration.

Request:
```json
{
  "agentId": "agent-alpha"
}
```

## Message/event flow

### POST /mcp/events/publish

Publish normalized event into router.

- Agent publisher must be approved for target session.
- Guard action by confidence:
  - `>=0.95`: stop (no append/fan-out)
  - `>0.7 && <0.95`: append loop-warning note for receiving agent decision
  - otherwise: normal append/fan-out (may still be delayed)
- On append success, router pushes event to all approved agent callbacks in that session (excluding origin agent to avoid immediate self-loop).

Request (example):
```json
{
  "traceId": "trace-123",
  "sessionKey": "telegram:-100:topic-98",
  "sourceChannel": "telegram",
  "sourceChatId": "-100",
  "sourceThreadId": "98",
  "sourceMessageId": "5001",
  "originActorType": "agent",
  "originActorId": "agent-alpha",
  "text": "Draft response...",
  "hopCount": 1,
  "seenAgents": ["agent-alpha"],
  "emittedByAgentId": "agent-alpha",
  "emittedEventId": "evt-out-1"
}
```

Response:
```json
{
  "accepted": true,
  "delayed": true,
  "delayMs": 10000,
  "decision": {
    "isErrorLoop": true,
    "reason": "near-identical repeated outputs detected; delayed for safety",
    "confidence": 0.8
  }
}
```

### Callback payload (router -> agent)

Router sends `POST callbackUrl`:
```json
{
  "type": "router.event",
  "deliveryId": "...",
  "deliveredAt": 1739680000000,
  "event": { "...event envelope..." }
}
```

Headers:
- `x-router-agent-id`
- `x-router-event-id`
- `x-router-attempt`
- `x-router-signature` (if `callbackSecret` is set)
- `x-router-signature-alg: hmac-sha256` (if signed)

### GET /mcp/sessions/:sessionKey/events?agentId=...

Pull fallback: fetch events for a session. Requires admin-approved authorization.

## GET /health

Health check + basic stats.
