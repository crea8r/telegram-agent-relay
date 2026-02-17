# API

## Agent onboarding flow

### POST /agents/register

Agent requests access. This does **not** grant access yet.

Request:
```json
{
  "agentId": "agent-alpha",
  "displayName": "Alpha Planner",
  "callbackUrl": "https://agent.example.com/hook",
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

Publish normalized event.

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

### GET /mcp/sessions/:sessionKey/events?agentId=...

Fetch events for a session. Requires admin-approved whitelist authorization.

## GET /health

Health check endpoint.
