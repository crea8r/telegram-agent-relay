import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface DeliveryRecord {
  deliveryId: string;
  eventId: string;
  sessionKey: string;
  targetAgentId: string;
  status: 'success' | 'failed' | 'retry';
  attempt: number;
  error?: string;
}

export interface LoopDecisionRecord {
  eventId: string;
  sessionKey: string;
  isErrorLoop: boolean;
  confidence: number;
  action: 'normal' | 'warn' | 'stop';
  reason: string;
}

export class RouterDb {
  private db: DatabaseSync;

  constructor(path = process.env.SQLITE_PATH ?? './data/router.db') {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY,
        trace_id TEXT NOT NULL,
        session_key TEXT NOT NULL,
        origin_actor_type TEXT NOT NULL,
        origin_actor_id TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS loop_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL,
        session_key TEXT NOT NULL,
        is_error_loop INTEGER NOT NULL,
        confidence REAL NOT NULL,
        action TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS deliveries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        delivery_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        session_key TEXT NOT NULL,
        target_agent_id TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        error TEXT,
        created_at INTEGER NOT NULL
      );
    `);
  }

  insertEvent(evt: { eventId: string; traceId: string; sessionKey: string; originActorType: string; originActorId: string; text: string; createdAt: number }) {
    const stmt = this.db.prepare(`INSERT OR IGNORE INTO events(event_id, trace_id, session_key, origin_actor_type, origin_actor_id, text, created_at) VALUES(?,?,?,?,?,?,?)`);
    stmt.run(evt.eventId, evt.traceId, evt.sessionKey, evt.originActorType, evt.originActorId, evt.text, evt.createdAt);
  }

  insertLoopDecision(d: LoopDecisionRecord) {
    const stmt = this.db.prepare(`INSERT INTO loop_decisions(event_id, session_key, is_error_loop, confidence, action, reason, created_at) VALUES(?,?,?,?,?,?,?)`);
    stmt.run(d.eventId, d.sessionKey, d.isErrorLoop ? 1 : 0, d.confidence, d.action, d.reason, Date.now());
  }

  insertDelivery(d: DeliveryRecord) {
    const stmt = this.db.prepare(`INSERT INTO deliveries(delivery_id, event_id, session_key, target_agent_id, status, attempt, error, created_at) VALUES(?,?,?,?,?,?,?,?)`);
    stmt.run(d.deliveryId, d.eventId, d.sessionKey, d.targetAgentId, d.status, d.attempt, d.error ?? null, Date.now());
  }

  metrics() {
    const q = this.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM events) AS events,
        (SELECT COUNT(*) FROM loop_decisions WHERE action='stop') AS stopped,
        (SELECT COUNT(*) FROM loop_decisions WHERE action='warn') AS warned,
        (SELECT COUNT(*) FROM deliveries WHERE status='success') AS delivered,
        (SELECT COUNT(*) FROM deliveries WHERE status='failed') AS failed
    `);
    return q.get() as Record<string, number>;
  }

  recentLoops(limit = 100) {
    return this.db.prepare(`SELECT * FROM loop_decisions ORDER BY id DESC LIMIT ?`).all(limit);
  }

  recentDeliveries(limit = 100) {
    return this.db.prepare(`SELECT * FROM deliveries ORDER BY id DESC LIMIT ?`).all(limit);
  }

  sessions(limit = 200) {
    return this.db
      .prepare(`SELECT session_key, COUNT(*) AS events, MAX(created_at) AS last_at FROM events GROUP BY session_key ORDER BY last_at DESC LIMIT ?`)
      .all(limit);
  }
}
