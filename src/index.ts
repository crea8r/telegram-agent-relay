import express from 'express';
import pino from 'pino';
import 'dotenv/config';
import { z } from 'zod';
import { randomUUID, createHmac } from 'node:crypto';
import { Store } from './store.js';
import { LoopGuard } from './loopGuard.js';
import type { EventEnvelope } from './types.js';
import { registerAdminRoutes, type AgentRegistration, type WhitelistState } from './adminRoutes.js';
import { RouterDb } from './db.js';

const log = pino({ transport: { target: 'pino-pretty' } });
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use('/admin/ui', express.static('public/admin'));

const db = new RouterDb();
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
const adminPassword = process.env.ADMIN_PASSWORD ?? 'admin123';
const adminSessions = new Map<string, number>();

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

function parseCookies(cookieHeader?: string) {
  const out: Record<string, string> = {};
  if (!cookieHeader) return out;
  cookieHeader.split(';').forEach((part) => {
    const [k, ...v] = part.trim().split('=');
    out[k] = decodeURIComponent(v.join('='));
  });
  return out;
}

const requireAdmin: express.RequestHandler = (req, res, next) => {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies.admin_token;
  if (!token) return res.status(401).json({ error: 'unauthorized' });
  const exp = adminSessions.get(token);
  if (!exp || exp < Date.now()) return res.status(401).json({ error: 'session expired' });
  next();
};

app.post('/admin/login', (req, res) => {
  const parsed = z.object({ password: z.string() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json(parsed.error.flatten());
  if (parsed.data.password !== adminPassword) return res.status(401).json({ ok: false, error: 'invalid password' });
  const token = randomUUID();
  adminSessions.set(token, Date.now() + 24 * 60 * 60 * 1000);
  res.setHeader('Set-Cookie', `admin_token=${encodeURIComponent(token)}; HttpOnly; Path=/; Max-Age=86400; SameSite=Lax`);
  res.json({ ok: true });
});

app.post('/admin/logout', requireAdmin, (req, res) => {
  const token = parseCookies(req.headers.cookie).admin_token;
  if (token) adminSessions.delete(token);
  res.setHeader('Set-Cookie', 'admin_token=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax');
  res.json({ ok: true });
});

app.get('/admin/session', requireAdmin, (_req, res) => res.json({ ok: true }));

app.get('/admin/api/metrics', requireAdmin, (_req, res) => res.json(db.metrics()));
app.get('/admin/api/sessions', requireAdmin, (req, res) => res.json(db.sessions(Number(req.query.limit ?? 200))));
app.get('/admin/api/deliveries', requireAdmin, (req, res) => res.json(db.recentDeliveries(Number(req.query.limit ?? 100))));
app.get('/admin/api/loops', requireAdmin, (req, res) => res.json(db.recentLoops(Number(req.query.limit ?? 100))));

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

async function deliverToAgent(agent: AgentRegistration, evt: EventEnvelope, deliveryId: string, attempt = 1): Promise<void> {
  const payload = {
    type: 'router.event',
    deliveryId,
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
    const response = await fetch(agent.callbackUrl, { method: 'POST', headers, body: payloadText });
    if (!response.ok) throw new Error(`callback non-2xx (${response.status})`);
    db.insertDelivery({ deliveryId, eventId: evt.eventId, sessionKey: evt.sessionKey, targetAgentId: agent.agentId, status: 'success', attempt });
    log.info({ agentId: agent.agentId, eventId: evt.eventId, attempt }, 'event delivered to agent callback');
  } catch (error) {
    const err = String(error);
    if (attempt >= deliveryMaxRetries) {
      db.insertDelivery({ deliveryId, eventId: evt.eventId, sessionKey: evt.sessionKey, targetAgentId: agent.agentId, status: 'failed', attempt, error: err });
      log.error({ agentId: agent.agentId, eventId: evt.eventId, err }, 'delivery failed after max retries');
      return;
    }

    db.insertDelivery({ deliveryId, eventId: evt.eventId, sessionKey: evt.sessionKey, targetAgentId: agent.agentId, status: 'retry', attempt, error: err });
    const delay = deliveryBaseDelayMs * Math.pow(2, attempt - 1);
    setTimeout(() => void deliverToAgent(agent, evt, deliveryId, attempt + 1), delay);
  }
}

function fanOutEvent(evt: EventEnvelope) {
  const recipients = getApprovedRecipients(evt.sessionKey);
  for (const agent of recipients) {
    if (evt.originActorType === 'agent' && evt.originActorId === agent.agentId) continue;
    void deliverToAgent(agent, evt, randomUUID());
  }
}

app.post('/agents/register', (req, res) => {
  const parsed = AgentRegistrationSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json(parsed.error.flatten());

  const registration: AgentRegistration = { ...parsed.data, registeredAt: Date.now(), status: 'pending' };
  whitelist.registrations.set(parsed.data.agentId, registration);
  res.status(202).json({ ok: true, status: 'pending', message: 'agent registered; waiting for admin approval' });
});

registerAdminRoutes(app, whitelist, requireAdmin);

app.post('/mcp/events/publish', async (req, res) => {
  const parsed = EventSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json(parsed.error.flatten());

  const evt: EventEnvelope = { ...parsed.data, eventId: parsed.data.eventId ?? randomUUID(), createdAt: Date.now() };

  if (evt.originActorType === 'agent' && !canAgentAccessSession(evt.originActorId, evt.sessionKey)) {
    return res.status(403).json({ accepted: false, reason: 'agent not approved for this session' });
  }
  if (evt.emittedEventId) {
    if (whitelist.seenEmittedEventIds.has(evt.emittedEventId)) return res.json({ accepted: false, reason: 'self-echo duplicate emittedEventId blocked' });
    whitelist.seenEmittedEventIds.add(evt.emittedEventId);
  }

  const { delayMs, decision } = await guard.evaluate(evt);
  const action = decision.isErrorLoop && decision.confidence >= 0.95 ? 'stop' : decision.isErrorLoop && decision.confidence > 0.7 ? 'warn' : 'normal';
  db.insertLoopDecision({ eventId: evt.eventId, sessionKey: evt.sessionKey, isErrorLoop: decision.isErrorLoop, confidence: decision.confidence, action, reason: decision.reason });

  if (action === 'stop') return res.json({ accepted: false, stopped: true, decision });

  let outboundEvent = evt;
  if (action === 'warn') {
    outboundEvent = {
      ...evt,
      text: `${evt.text}\n\n[LOOP_GUARD_NOTE] Possible error loop detected (confidence=${decision.confidence.toFixed(2)}). Please evaluate and stop if erroneous.`
    };
  }

  const run = () => {
    const accepted = store.append(outboundEvent);
    if (!accepted) return;
    db.insertEvent({ eventId: outboundEvent.eventId, traceId: outboundEvent.traceId, sessionKey: outboundEvent.sessionKey, originActorType: outboundEvent.originActorType, originActorId: outboundEvent.originActorId, text: outboundEvent.text, createdAt: outboundEvent.createdAt });
    fanOutEvent(outboundEvent);
  };

  if (delayMs > 0) setTimeout(run, delayMs);
  else run();

  res.json({ accepted: true, delayed: delayMs > 0, delayMs, decision });
});

app.get('/mcp/sessions/:sessionKey/events', (req, res) => {
  const agentId = String(req.query.agentId || '');
  const { sessionKey } = req.params;
  if (!canAgentAccessSession(agentId, sessionKey)) return res.status(403).json({ error: 'not authorized by admin-approved whitelist' });
  res.json({ sessionKey, events: store.list(sessionKey) });
});

app.get('/health', (_req, res) => res.json({ ok: true, stats: { approvedAgents: whitelist.approvedAgents.size } }));

const port = Number(process.env.PORT ?? '8787');
app.listen(port, () => log.info({ port }, 'telegram-agent-relay running'));
