import express from 'express';
import pino from 'pino';
import 'dotenv/config';
import { z } from 'zod';
import { randomUUID, createHmac } from 'node:crypto';
import { Store } from './store.js';
import { LoopGuard } from './loopGuard.js';
import type { EventEnvelope } from './types.js';
import { registerAdminRoutes, type AgentRegistration, type WhitelistState } from './adminRoutes.js';

const log = pino({ transport: { target: 'pino-pretty' } });
const app = express();
app.use(express.json({ limit: '1mb' }));

const store = new Store();
const maxPerMinute = Number(process.env.LOOP_MAX_PER_MINUTE ?? '6');
const loopDelayDefaultMs = Number(process.env.LOOP_DELAY_DEFAULT_MS ?? '2000');
const loopDelayBurstMs = Number(process.env.LOOP_DELAY_BURST_MS ?? String(loopDelayDefaultMs));
const guard = new LoopGuard(store, maxPerMinute, {
  delayDefaultMs: loopDelayDefaultMs,
  delayBurstMs: loopDelayBurstMs
});
const deliveryMaxRetries = Number(process.env.DELIVERY_MAX_RETRIES ?? '3');
const deliveryBaseDelayMs = Number(process.env.DELIVERY_BASE_DELAY_MS ?? '1000');

const EventSchema = z.object({
  eventId: z.string().optional(),
  traceId: z.string(),
  sessionKey: z.string(),
  sourceChannel: z.string(),
  sourceChatId: z.string(),
  sourceThreadId: z.string(),
  sourceMessageId: z.string(),
  originActorType: z.enum(['human', 'agent', 'system']),
  originActorId: z.string(),
  text: z.string().min(1),
  hopCount: z.number().int().nonnegative().default(0),
  seenAgents: z.array(z.string()).default([]),
  emittedByAgentId: z.string().optional(),
  emittedEventId: z.string().optional()
});

const AgentRegistrationSchema = z.object({
  agentId: z.string().min(1),
  displayName: z.string().optional(),
  callbackUrl: z.string().url(),
  callbackSecret: z.string().min(8).optional(),
  requestedSessionKeys: z.array(z.string()).default([])
});

const whitelist: WhitelistState = {
  approvedAgents: new Set<string>(),
  sessionsByAgent: new Map<string, Set<string>>(),
  registrations: new Map<string, AgentRegistration>(),
  seenEmittedEventIds: new Set<string>()
};

function canAgentAccessSession(agentId: string, sessionKey: string) {
  if (!whitelist.approvedAgents.has(agentId)) return false;
  const allowed = whitelist.sessionsByAgent.get(agentId);
  return !!allowed?.has(sessionKey);
}

function getApprovedRecipients(sessionKey: string) {
  const recipients: AgentRegistration[] = [];
  for (const agentId of whitelist.approvedAgents) {
    if (!canAgentAccessSession(agentId, sessionKey)) continue;
    const reg = whitelist.registrations.get(agentId);
    if (!reg || reg.status !== 'approved') continue;
    recipients.push(reg);
  }
  return recipients;
}

function createSignature(secret: string, body: string) {
  return createHmac('sha256', secret).update(body).digest('hex');
}

async function deliverToAgent(agent: AgentRegistration, evt: EventEnvelope, attempt = 1): Promise<void> {
  const payload = {
    type: 'router.event',
    deliveryId: randomUUID(),
    deliveredAt: Date.now(),
    event: evt
  };
  const payloadText = JSON.stringify(payload);

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-router-agent-id': agent.agentId,
    'x-router-event-id': evt.eventId,
    'x-router-attempt': String(attempt)
  };

  if (agent.callbackSecret) {
    headers['x-router-signature'] = createSignature(agent.callbackSecret, payloadText);
    headers['x-router-signature-alg'] = 'hmac-sha256';
  }

  try {
    const response = await fetch(agent.callbackUrl, {
      method: 'POST',
      headers,
      body: payloadText
    });

    if (!response.ok) {
      throw new Error(`callback non-2xx (${response.status})`);
    }

    log.info({ agentId: agent.agentId, eventId: evt.eventId, attempt }, 'event delivered to agent callback');
  } catch (error) {
    if (attempt >= deliveryMaxRetries) {
      log.error({ agentId: agent.agentId, eventId: evt.eventId, err: String(error) }, 'delivery failed after max retries');
      return;
    }

    const delay = deliveryBaseDelayMs * Math.pow(2, attempt - 1);
    log.warn({ agentId: agent.agentId, eventId: evt.eventId, attempt, delay, err: String(error) }, 'delivery failed, retry scheduled');
    setTimeout(() => {
      void deliverToAgent(agent, evt, attempt + 1);
    }, delay);
  }
}

function fanOutEvent(evt: EventEnvelope) {
  const recipients = getApprovedRecipients(evt.sessionKey);
  for (const agent of recipients) {
    if (evt.originActorType === 'agent' && evt.originActorId === agent.agentId) continue;
    void deliverToAgent(agent, evt);
  }
}

app.post('/agents/register', (req, res) => {
  const parsed = AgentRegistrationSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json(parsed.error.flatten());

  const registration: AgentRegistration = {
    ...parsed.data,
    registeredAt: Date.now(),
    status: 'pending'
  };

  whitelist.registrations.set(parsed.data.agentId, registration);
  log.info({ agentId: parsed.data.agentId, callbackUrl: parsed.data.callbackUrl }, 'agent registration pending approval');

  res.status(202).json({
    ok: true,
    status: 'pending',
    message: 'agent registered; waiting for admin approval'
  });
});

registerAdminRoutes(app, whitelist);

app.post('/mcp/events/publish', async (req, res) => {
  const parsed = EventSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json(parsed.error.flatten());

  const evt: EventEnvelope = {
    ...parsed.data,
    eventId: parsed.data.eventId ?? randomUUID(),
    createdAt: Date.now()
  };

  if (evt.originActorType === 'agent' && !canAgentAccessSession(evt.originActorId, evt.sessionKey)) {
    return res.status(403).json({ accepted: false, reason: 'agent not approved for this session' });
  }

  if (evt.emittedEventId) {
    if (whitelist.seenEmittedEventIds.has(evt.emittedEventId)) {
      return res.json({ accepted: false, reason: 'self-echo duplicate emittedEventId blocked' });
    }
    whitelist.seenEmittedEventIds.add(evt.emittedEventId);
  }

  const { delayMs, decision } = await guard.evaluate(evt);

  // hard-stop path: do not append/fan-out
  if (decision.isErrorLoop && decision.confidence >= 0.95) {
    log.warn({ eventId: evt.eventId, sessionKey: evt.sessionKey, decision }, 'event stopped by loop guard');
    return res.json({ accepted: false, stopped: true, delayMs: 0, decision });
  }

  // soft-warning path: append guard note for agent decision
  let outboundEvent = evt;
  if (decision.isErrorLoop && decision.confidence > 0.7 && decision.confidence < 0.95) {
    outboundEvent = {
      ...evt,
      text:
        `${evt.text}\n\n[LOOP_GUARD_NOTE] Possible error loop detected (confidence=${decision.confidence.toFixed(2)}). ` +
        'Please evaluate and stop if this is an erroneous loop.'
    };
  }

  const enqueueAndFanout = () => {
    const accepted = store.append(outboundEvent);
    if (!accepted) {
      log.warn({ eventId: outboundEvent.eventId }, 'duplicate event ignored');
      return;
    }

    log.info({ eventId: outboundEvent.eventId, sessionKey: outboundEvent.sessionKey, delayMs, decision }, 'event appended');
    fanOutEvent(outboundEvent);
  };

  if (delayMs > 0) setTimeout(enqueueAndFanout, delayMs);
  else enqueueAndFanout();

  res.json({ accepted: true, delayed: delayMs > 0, delayMs, decision });
});

app.get('/mcp/sessions/:sessionKey/events', (req, res) => {
  const agentId = String(req.query.agentId || '');
  const { sessionKey } = req.params;
  if (!canAgentAccessSession(agentId, sessionKey)) {
    return res.status(403).json({ error: 'not authorized by admin-approved whitelist' });
  }
  const events = store.list(sessionKey);
  res.json({ sessionKey, events });
});

app.get('/health', (_req, res) =>
  res.json({
    ok: true,
    stats: {
      approvedAgents: whitelist.approvedAgents.size,
      registrations: whitelist.registrations.size,
      sessions: whitelist.sessionsByAgent.size
    }
  })
);

const port = Number(process.env.PORT ?? '8787');
app.listen(port, () => log.info({ port }, 'openclaw-context-router running'));
