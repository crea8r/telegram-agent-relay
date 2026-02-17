# Agent Bridge (Node)

Reference bridge that connects router callbacks to local OpenClaw sessions.

## Endpoints

- `POST /router/events` — receive router callback, map session, forward to local OpenClaw append endpoint
- `POST /agent/outbound` — publish local agent response back to router
- `GET /bridge/sessions` — inspect router/local session mapping

## Why this exists

Router knows global `sessionKey`, but each agent runtime needs local session mapping.
This bridge performs that mapping and preserves session isolation correctness.
