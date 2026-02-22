import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { LoopGuard } from '../dist/loopGuard.js';
import { Store } from '../dist/store.js';

function mkEvent(overrides = {}) {
  return {
    eventId: overrides.eventId ?? randomUUID(),
    traceId: overrides.traceId ?? 'trace-1',
    sessionKey: overrides.sessionKey ?? 'telegram:-100:topic-98',
    sourceChannel: 'telegram',
    sourceChatId: '-100',
    sourceThreadId: '98',
    sourceMessageId: overrides.sourceMessageId ?? String(Date.now()),
    originActorType: 'agent',
    originActorId: 'agent-alpha',
    text: overrides.text ?? 'hello world',
    hopCount: 0,
    seenAgents: ['agent-alpha'],
    createdAt: Date.now(),
    ...overrides
  };
}

test('LoopGuard returns accepted when no loop pattern is detected', async () => {
  const store = new Store();
  const guard = new LoopGuard(store, 6, { delayDefaultMs: 2000, delayBurstMs: 2000 });

  const result = await guard.evaluate(mkEvent());
  assert.equal(result.delayMs, 0);
  assert.equal(result.decision.isErrorLoop, false);
});

test('LoopGuard delays repetitive events using default delay', async () => {
  const store = new Store();
  const guard = new LoopGuard(store, 6, { delayDefaultMs: 2000, delayBurstMs: 9000 });

  const base = 'same repeated output';
  store.append(mkEvent({ text: base, eventId: 'e1' }));
  store.append(mkEvent({ text: base, eventId: 'e2' }));
  store.append(mkEvent({ text: base, eventId: 'e3' }));

  const result = await guard.evaluate(mkEvent({ text: base, eventId: 'e4' }));
  assert.equal(result.decision.isErrorLoop, true);
  assert.equal(result.delayMs, 2000);
  assert.equal(result.decision.confidence, 0.8);
});

test('LoopGuard applies burst delay when max per minute exceeded', async () => {
  const store = new Store();
  const guard = new LoopGuard(store, 3, { delayDefaultMs: 2000, delayBurstMs: 7000 });

  store.append(mkEvent({ eventId: 'e1' }));
  store.append(mkEvent({ eventId: 'e2' }));
  store.append(mkEvent({ eventId: 'e3' }));

  const result = await guard.evaluate(mkEvent({ eventId: 'e4' }));
  assert.equal(result.decision.isErrorLoop, true);
  assert.equal(result.decision.confidence, 0.95);
  assert.equal(result.delayMs, 7000);
});
