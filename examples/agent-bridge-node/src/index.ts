import express from 'express';
import { z } from 'zod';
import pino from 'pino';
import 'dotenv/config';
import { createHmac } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

type RouterEvent = {
  eventId: string;
  traceId: string;
  sessionKey: string;
  text: string;
  originActorType: 'human' | 'agent' | 'system';
  originActorId: string;
  sourceChannel: string;
  sourceChatId: string;
  sourceThreadId: string;
  sourceMessageId: string;
  createdAt: number;
};

const log = pino({ transport: { target: 'pino-pretty' } });
const app = express();
app.use(express.json({ limit: '1mb' }));

const bridgeAgentId = process.env.BRIDGE_AGENT_ID ?? 'agent-alpha';
const routerBaseUrl = process.env.ROUTER_BASE_URL ?? 'http://localhost:8787';
const callbackSecret = process.env.ROUTER_CALLBACK_SECRET ?? '';
const appendUrl = process.env.OPENCLAW_APPEND_URL ?? '';
const appendToken = process.env.OPENCLAW_APPEND_TOKEN ?? '';

const mapPath = resolve(process.cwd(), '.data/session-map.json');
const seenPath = resolve(process.cwd(), '.data/seen-deliveries.json');

function ensureDir(path: string) {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function loadJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function saveJson(path: string, data: unknown) {
  ensureDir(path);
  writeFileSync(path, JSON.stringify(data, null, 2));
}

const sessionMap = loadJson<Record<string, string>>(mapPath, {});
const seenDeliveries = new Set(loadJson<string[]>(seenPath, []));

function resolveLocalSessionKey(routerSessionKey: string): string {
  const existing = sessionMap[routerSessionKey];
  if (existing) return existing;
  const generated = `${bridgeAgentId}::${routerSessionKey}`;
  sessionMap[routerSessionKey] = generated;
  saveJson(mapPath, sessionMap);
  return generated;
}

function checkSignature(body: string, headerSig: string | undefined): boolean {
  if (!callbackSecret) return true;
  if (!headerSig) return false;
  const expected = createHmac('sha256', callbackSecret).update(body).digest('hex');
  return expected === headerSig;
}

async function appendIntoOpenClaw(localSessionKey: string, evt: RouterEvent) {
  if (!appendUrl) {
    log.warn({ localSessionKey, routerSessionKey: evt.sessionKey }, 'OPENCLAW_APPEND_URL not set; event received but not forwarded');
    return { ok: false, skipped: true };
  }

  const payload = {
    sessionKey: localSessionKey,
    message: evt.text,
    metadata: {
      routerSessionKey: evt.sessionKey,
      routerEventId: evt.eventId,
      traceId: evt.traceId,
      source: {
        channel: evt.sourceChannel,
        chatId: evt.sourceChatId,
        threadId: evt.sourceThreadId,
        messageId: evt.sourceMessageId
      },
      origin: {
        actorType: evt.originActorType,
        actorId: evt.originActorId
      }
    }
  };

  const headers: Record<string, string> = {
    'content-type': 'application/json'
  };
  if (appendToken) headers.authorization = `Bearer ${appendToken}`;

  const res = await fetch(appendUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`append failed ${res.status}: ${text}`);
  }

  return { ok: true };
}

const CallbackSchema = z.object({
  type: z.literal('router.event'),
  deliveryId: z.string(),
  deliveredAt: z.number(),
  event: z.object({
    eventId: z.string(),
    traceId: z.string(),
    sessionKey: z.string(),
    text: z.string(),
    originActorType: z.enum(['human', 'agent', 'system']),
    originActorId: z.string(),
    sourceChannel: z.string(),
    sourceChatId: z.string(),
    sourceThreadId: z.string(),
    sourceMessageId: z.string(),
    createdAt: z.number()
  })
});

app.post('/router/events', async (req, res) => {
  const raw = JSON.stringify(req.body ?? {});
  const sig = req.header('x-router-signature') ?? undefined;
  if (!checkSignature(raw, sig)) {
    return res.status(401).json({ ok: false, error: 'invalid signature' });
  }

  const parsed = CallbackSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json(parsed.error.flatten());

  const { deliveryId, event } = parsed.data;
  if (seenDeliveries.has(deliveryId)) {
    return res.json({ ok: true, deduped: true });
  }

  seenDeliveries.add(deliveryId);
  saveJson(seenPath, [...seenDeliveries]);

  try {
    const localSessionKey = resolveLocalSessionKey(event.sessionKey);
    await appendIntoOpenClaw(localSessionKey, event as RouterEvent);
    return res.json({ ok: true, localSessionKey });
  } catch (error) {
    log.error({ err: String(error), deliveryId }, 'failed to append into local OpenClaw session');
    return res.status(500).json({ ok: false, error: 'append failed' });
  }
});

const OutboundSchema = z.object({
  localSessionKey: z.string(),
  text: z.string().min(1),
  traceId: z.string().optional()
});

app.post('/agent/outbound', async (req, res) => {
  const parsed = OutboundSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json(parsed.error.flatten());

  const routerSessionKey = Object.entries(sessionMap).find(([, local]) => local === parsed.data.localSessionKey)?.[0];
  if (!routerSessionKey) {
    return res.status(404).json({ ok: false, error: 'localSessionKey not mapped to router session' });
  }

  const body = {
    traceId: parsed.data.traceId ?? `trace-${Date.now()}`,
    sessionKey: routerSessionKey,
    sourceChannel: 'agent-bridge',
    sourceChatId: bridgeAgentId,
    sourceThreadId: routerSessionKey,
    sourceMessageId: `msg-${Date.now()}`,
    originActorType: 'agent',
    originActorId: bridgeAgentId,
    text: parsed.data.text,
    hopCount: 0,
    seenAgents: [bridgeAgentId],
    emittedByAgentId: bridgeAgentId,
    emittedEventId: `emit-${Date.now()}-${Math.random().toString(16).slice(2)}`
  };

  const publishRes = await fetch(`${routerBaseUrl}/mcp/events/publish`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });

  const publishJson = await publishRes.json();
  if (!publishRes.ok) return res.status(publishRes.status).json(publishJson);
  res.json({ ok: true, routerSessionKey, publish: publishJson });
});

app.get('/bridge/sessions', (_req, res) => {
  res.json({ map: sessionMap });
});

const port = Number(process.env.BRIDGE_PORT ?? '8899');
app.listen(port, () => log.info({ port, bridgeAgentId }, 'agent bridge running'));