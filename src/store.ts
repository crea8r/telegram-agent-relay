import type { EventEnvelope } from './types.js';

export class Store {
  private eventsBySession = new Map<string, EventEnvelope[]>();
  private seenEventIds = new Set<string>();

  append(evt: EventEnvelope) {
    if (this.seenEventIds.has(evt.eventId)) return false;
    this.seenEventIds.add(evt.eventId);
    const arr = this.eventsBySession.get(evt.sessionKey) ?? [];
    arr.push(evt);
    this.eventsBySession.set(evt.sessionKey, arr);
    return true;
  }

  list(sessionKey: string) {
    return this.eventsBySession.get(sessionKey) ?? [];
  }

  recentByTrace(traceId: string, withinMs: number) {
    const now = Date.now();
    const out: EventEnvelope[] = [];
    for (const arr of this.eventsBySession.values()) {
      for (const e of arr) {
        if (e.traceId === traceId && now - e.createdAt <= withinMs) out.push(e);
      }
    }
    return out.sort((a, b) => a.createdAt - b.createdAt);
  }
}
