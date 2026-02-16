# API

## POST /admin/whitelist/agent

Register/update allowed sessions for an agent.

Request:
```json
{
  "agentId": "agent-alpha",
  "sessionKeys": ["telegram:-100:topic-98"]
}
```

## POST /mcp/events/publish

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

## GET /mcp/sessions/:sessionKey/events?agentId=...

Fetch events for a session. Requires agent whitelist authorization.

## GET /health

Health check endpoint.
