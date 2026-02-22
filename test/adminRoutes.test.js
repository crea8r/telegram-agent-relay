import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { registerAdminRoutes } from '../dist/adminRoutes.js';

function makeState() {
  return {
    approvedAgents: new Set(),
    sessionsByAgent: new Map(),
    registrations: new Map(),
    seenEmittedEventIds: new Set()
  };
}

function makeApp(state) {
  const app = express();
  app.use(express.json());
  registerAdminRoutes(app, state);
  return app;
}

test('approve transitions pending registration to approved with session grants', async () => {
  const state = makeState();
  state.registrations.set('agent-alpha', {
    agentId: 'agent-alpha',
    callbackUrl: 'https://agent.example.com/hook',
    requestedSessionKeys: [],
    registeredAt: Date.now(),
    status: 'pending'
  });

  const app = makeApp(state);
  const res = await request(app)
    .post('/admin/agents/approve')
    .send({ agentId: 'agent-alpha', sessionKeys: ['telegram:-100:topic-98'] });

  assert.equal(res.status, 200);
  assert.equal(state.approvedAgents.has('agent-alpha'), true);
  assert.equal(state.sessionsByAgent.get('agent-alpha')?.has('telegram:-100:topic-98'), true);
  assert.equal(state.registrations.get('agent-alpha')?.status, 'approved');
});

test('reject transitions registration and removes approvals', async () => {
  const state = makeState();
  state.registrations.set('agent-beta', {
    agentId: 'agent-beta',
    callbackUrl: 'https://agent.example.com/hook',
    requestedSessionKeys: ['telegram:-100:topic-98'],
    registeredAt: Date.now(),
    status: 'approved'
  });
  state.approvedAgents.add('agent-beta');
  state.sessionsByAgent.set('agent-beta', new Set(['telegram:-100:topic-98']));

  const app = makeApp(state);
  const res = await request(app)
    .post('/admin/agents/reject')
    .send({ agentId: 'agent-beta' });

  assert.equal(res.status, 200);
  assert.equal(state.approvedAgents.has('agent-beta'), false);
  assert.equal(state.sessionsByAgent.has('agent-beta'), false);
  assert.equal(state.registrations.get('agent-beta')?.status, 'rejected');
});

test('pending endpoint only returns pending registrations', async () => {
  const state = makeState();
  state.registrations.set('p1', { agentId: 'p1', callbackUrl: 'https://a', requestedSessionKeys: [], registeredAt: Date.now(), status: 'pending' });
  state.registrations.set('a1', { agentId: 'a1', callbackUrl: 'https://b', requestedSessionKeys: [], registeredAt: Date.now(), status: 'approved' });

  const app = makeApp(state);
  const res = await request(app).get('/admin/agents/pending');

  assert.equal(res.status, 200);
  assert.equal(res.body.pending.length, 1);
  assert.equal(res.body.pending[0].agentId, 'p1');
});
