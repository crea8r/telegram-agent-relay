import express from 'express';
import pino from 'pino';
import 'dotenv/config';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { Store } from './store.js';
import { LoopGuard } from './loopGuard.js';
import type { EventEnvelope } from './types.js';

const log = pino({ transport: { target: 'pino-pretty' } });
const app = express();
app.use(express.json({ limit: '1mb' }));

const store = new Store();
const maxPerMinute = Number(process.env.LOOP_MAX_PER_MINUTE ?? '6');
const guard = new LoopGuard(store, maxPerMinute);

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
  callbackUrl: z.string().url().optional(),
  requestedSessionKeys: z.array(z.string()).default([])
});

const AdminApprovalSchema = z.object({
  agentId: z.string().min(1),
  sessionKeys: z.array(z.string()).default([])
});

const whitelist = {
  approvedAgents: new Set<string>(),
  sessionsByAgent: new Map<string, Set<string>>(),
  pendingRegistrations: new Map<
    string,
    {
      agentId: string;
      displayName?: string;
      callbackUrl?: string;
      requestedSessionKeys: string[];
      registeredAt: number;
      status: 'pending' | 'approved' | 'rejected';
    }
  >()
};

function canAgentRead(agentId: string, sessionKey: string) {
  if (!whitelist.approvedAgents.has(agentId)) return false;
  const allowed = whitelist.sessionsByAgent.get(agentId);
  return !!allowed?.has(sessionKey);
}

app.post('/agents/register', (req, res) => {
  const parsed = AgentRegistrationSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json(parsed.error.flatten());

  const registration = {
    ...parsed.data,
    registeredAt: Date.now(),
    status: 'pending' as const
  };

  whitelist.pendingRegistrations.set(parsed.data.agentId, registration);
  log.info({ agentId: parsed.data.agentId }, 'agent registration pending approval');

  res.status(202).json({
    ok: true,
    status: 'pending',
    message: 'agent registered; waiting for admin approval'
  });
});

app.get('/admin/agents/pending', (_req, res) => {
  const pending = [...whitelist.pendingRegistrations.values()].filter((r) => r.status === 'pending');
  res.json({ pending });
});

app.post('/admin/agents/approve', (req, res) => {
  const parsed = AdminApprovalSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json(parsed.error.flatten());

  const pending = whitelist.pendingRegistrations.get(parsed.data.agentId);
  if (!pending) {
    return res.status(404).json({ error: 'agent registration not found' });
  }

  whitelist.approvedAgents.add(parsed.data.agentId);
  whitelist.sessionsByAgent.set(parsed.data.agentId, new Set(parsed.data.sessionKeys));
  whitelist.pendingRegistrations.set(parsed.data.agentId, {
    ...pending,
    status: 'approved',
    requestedSessionKeys: parsed.data.sessionKeys
  });

  res.json({ ok: true, status: 'approved', agentId: parsed.data.agentId });
});

app.post('/admin/agents/reject', (req, res) => {
  const parsed = z.object({ agentId: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json(parsed.error.flatten());

  const pending = whitelist.pendingRegistrations.get(parsed.data.agentId);
  if (!pending) {
    return res.status(404).json({ error: 'agent registration not found' });
  }

  whitelist.pendingRegistrations.set(parsed.data.agentId, { ...pending, status: 'rejected' });
  whitelist.approvedAgents.delete(parsed.data.agentId);
  whitelist.sessionsByAgent.delete(parsed.data.agentId);

  res.json({ ok: true, status: 'rejected', agentId: parsed.data.agentId });
});

app.post('/mcp/events/publish', async (req, res) => {
  const parsed = EventSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json(parsed.error.flatten());

  const evt: EventEnvelope = {
    ...parsed.data,
    eventId: parsed.data.eventId ?? randomUUID(),
    createdAt: Date.now()
  };

  // self-message echo prevention
  if (evt.originActorType === 'agent' && evt.emittedByAgentId && evt.originActorId === evt.emittedByAgentId) {
    return res.json({ accepted: false, reason: 'self-echo blocked' });
  }

  const { delayMs, decision } = await guard.evaluate(evt);

  const enqueue = () => {
    const accepted = store.append(evt);
    log.info({ eventId: evt.eventId, sessionKey: evt.sessionKey, accepted, delayMs, decision }, 'event published');
  };

  if (delayMs > 0) setTimeout(enqueue, delayMs);
  else enqueue();

  res.json({ accepted: true, delayed: delayMs > 0, delayMs, decision });
});

app.get('/mcp/sessions/:sessionKey/events', (req, res) => {
  const agentId = String(req.query.agentId || '');
  const { sessionKey } = req.params;
  if (!canAgentRead(agentId, sessionKey)) {
    return res.status(403).json({ error: 'not authorized by admin-approved whitelist' });
  }
  const events = store.list(sessionKey);
  res.json({ sessionKey, events });
});

app.get('/health', (_req, res) => res.json({ ok: true }));

const port = Number(process.env.PORT ?? '8787');
app.listen(port, () => log.info({ port }, 'openclaw-context-router running'));