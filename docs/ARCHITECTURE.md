# Architecture

## Objective

Provide a standalone context-router + MCP server compatible with OpenClaw multi-agent setups.

## Core Invariants

1. One topic/thread => one `sessionKey`
2. Append each inbound message to exactly one session unless explicitly promoted
3. Preserve provenance metadata on every event
4. Agent access requires admin approval

## Event Envelope

Required fields (see `src/types.ts`):
- source references: `sourceChannel`, `sourceChatId`, `sourceThreadId`, `sourceMessageId`
- actor references: `originActorType`, `originActorId`
- loop controls: `traceId`, `hopCount`, `seenAgents`, `emittedByAgentId`, `emittedEventId`

## Loop Management (Updated B/C)

### B. Error-loop mitigation (intentional loop allowed)

- Loops are allowed by default.
- System identifies **error loops** using two checks:
  1. Throughput cap: max N loop events per minute (`LOOP_MAX_PER_MINUTE`, default 6)
  2. Repetition analysis: near-identical output across recent hops + optional LLM judgment

On suspected error loop, service delays enqueue instead of dropping messages.

### C. Trigger policy

- Agent-originated events are enabled by default.
- Every message can be evaluated by LLM-assisted classifier to detect repetitive/error loop patterns.
- Message actions:
  - normal => immediate append
  - suspected error loop => delayed append (cooldown)

## Self-message loop safety

Self-echo protection checks metadata (`originActorId`, `emittedByAgentId`, `emittedEventId`) and blocks obvious echo cycles.

## Whitelist flow (Agent register -> Admin approve)

1. Agent calls `POST /agents/register` and enters `pending` state
2. Admin reviews `GET /admin/agents/pending`
3. Admin grants access via `POST /admin/agents/approve` with allowed `sessionKeys`
4. Optional `POST /admin/agents/reject` for deny path
5. Only approved agents can read session events

## Production hardening roadmap

- durable store + ordered append
- distributed dedupe keys
- stronger authN/authZ (signed tokens, key rotation)
- metrics/alerts for repeated-delay traces
- dead-letter queue for unresolved loop traces
