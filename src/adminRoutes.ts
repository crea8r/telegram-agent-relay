import type { Express } from 'express';
import { z } from 'zod';

export type RegistrationStatus = 'pending' | 'approved' | 'rejected';

export interface AgentRegistration {
  agentId: string;
  displayName?: string;
  callbackUrl: string;
  callbackSecret?: string;
  requestedSessionKeys: string[];
  registeredAt: number;
  status: RegistrationStatus;
}

export interface WhitelistState {
  approvedAgents: Set<string>;
  sessionsByAgent: Map<string, Set<string>>;
  registrations: Map<string, AgentRegistration>;
  seenEmittedEventIds: Set<string>;
}

const AdminApprovalSchema = z.object({
  agentId: z.string().min(1),
  sessionKeys: z.array(z.string()).default([])
});

export function registerAdminRoutes(app: Express, whitelist: WhitelistState) {
  app.get('/admin/agents/pending', (_req, res) => {
    const pending = [...whitelist.registrations.values()].filter((r) => r.status === 'pending');
    res.json({ pending });
  });

  app.get('/admin/agents/approved', (_req, res) => {
    const approved = [...whitelist.registrations.values()].filter((r) => r.status === 'approved');
    res.json({ approved });
  });

  app.post('/admin/agents/approve', (req, res) => {
    const parsed = AdminApprovalSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json(parsed.error.flatten());

    const registration = whitelist.registrations.get(parsed.data.agentId);
    if (!registration) {
      return res.status(404).json({ error: 'agent registration not found' });
    }

    whitelist.approvedAgents.add(parsed.data.agentId);
    whitelist.sessionsByAgent.set(parsed.data.agentId, new Set(parsed.data.sessionKeys));

    whitelist.registrations.set(parsed.data.agentId, {
      ...registration,
      status: 'approved',
      requestedSessionKeys: parsed.data.sessionKeys
    });

    res.json({ ok: true, status: 'approved', agentId: parsed.data.agentId });
  });

  app.post('/admin/agents/reject', (req, res) => {
    const parsed = z.object({ agentId: z.string().min(1) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json(parsed.error.flatten());

    const registration = whitelist.registrations.get(parsed.data.agentId);
    if (!registration) {
      return res.status(404).json({ error: 'agent registration not found' });
    }

    whitelist.registrations.set(parsed.data.agentId, { ...registration, status: 'rejected' });
    whitelist.approvedAgents.delete(parsed.data.agentId);
    whitelist.sessionsByAgent.delete(parsed.data.agentId);

    res.json({ ok: true, status: 'rejected', agentId: parsed.data.agentId });
  });
}
