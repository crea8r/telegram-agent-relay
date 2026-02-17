# Architecture

## Objective

Provide a standalone context-router + MCP server compatible with OpenClaw multi-agent setups.

## Core Invariants

1. One topic/thread => one `sessionKey`
2. Append each inbound message to exactly one session unless explicitly promoted
3. Preserve provenance metadata on every event
4. Agent access requires admin approval
5. Router must push cross-agent events (callback delivery)

## Event Envelope

Required fields (see `src/types.ts`):
- source references: `sourceChannel`, `sourceChatId`, `sourceThreadId`, `sourceMessageId`
- actor references: `originActorType`, `originActorId`
- loop controls: `traceId`, `hopCount`, `seenAgents`, `emittedByAgentId`, `emittedEventId`

## End-to-end flow (complete)

1. Agent registers with callback endpoint (`POST /agents/register`)
2. Admin approves + grants `sessionKeys` (`POST /admin/agents/approve`)
3. Agent publishes event (`POST /mcp/events/publish`)
4. Router validates authorization + loop checks
5. Router appends event to session log
6. Router fan-outs event to other approved agents in same session via callback URL
7. Receiving agent decides whether/how to publish follow-up event

## Loop Management

### Intentional loops allowed

Agent-to-agent loops are allowed by default.

### Error-loop mitigation

- Throughput cap: max N loop events/minute (`LOOP_MAX_PER_MINUTE`, default 6)
- Repetition analysis: deterministic similarity heuristic on recent hops
- Delay controls from env: `LOOP_DELAY_DEFAULT_MS`, `LOOP_DELAY_BURST_MS` (defaults 2000ms)
- Action by confidence:
  - `>= 0.95`: hard stop (do not append/fan-out)
  - `> 0.7 && < 0.95`: append warning note to message so receiving agent decides whether to stop
  - otherwise: normal flow

### Self-message loop safety

- Duplicate `emittedEventId` blocked
- Router does not callback-push an agent's own emitted event back to same agent in same hop

## Whitelist flow

- Register => Pending
- Admin approve => Approved + session grants
- Admin reject => Denied
- Deny-by-default for all session reads/publishes

## Delivery semantics

- Push channel: callback webhook
- Retry: exponential backoff (`DELIVERY_MAX_RETRIES`, `DELIVERY_BASE_DELAY_MS`)
- Optional signed callback payload with HMAC (`callbackSecret`)
- Pull fallback endpoint remains available for recovery (`GET /mcp/sessions/:sessionKey/events`)

## Agent-machine requirements

Each agent runtime should run a small HTTP endpoint to receive router callbacks:
- expose HTTPS POST endpoint
- verify signature when configured
- dedupe by `deliveryId` / `event.eventId`
- ack quickly with 2xx, process async
- publish responses back to router with `/mcp/events/publish`
