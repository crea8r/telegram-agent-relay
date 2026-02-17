import type { EventEnvelope, RouterDecision } from './types.js';
import { Store } from './store.js';

const SIMILARITY_MIN = 0.95;

function normalize(s: string) {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

function jaccard(a: string, b: string) {
  const sa = new Set(normalize(a).split(' '));
  const sb = new Set(normalize(b).split(' '));
  const inter = [...sa].filter((x) => sb.has(x)).length;
  const union = new Set([...sa, ...sb]).size;
  return union === 0 ? 0 : inter / union;
}

interface LoopGuardOptions {
  delayDefaultMs: number;
  delayBurstMs: number;
}

export class LoopGuard {
  constructor(
    private store: Store,
    private maxPerMinute: number,
    private options: LoopGuardOptions
  ) {}

  async evaluate(candidate: EventEnvelope): Promise<{ delayMs: number; decision: RouterDecision }> {
    const recentTrace = this.store.recentByTrace(candidate.traceId, 60_000);

    const defaultDecision: RouterDecision = {
      isErrorLoop: false,
      reason: 'accepted',
      confidence: 0.6
    };

    if (recentTrace.length >= this.maxPerMinute) {
      return {
        delayMs: this.options.delayBurstMs,
        decision: {
          isErrorLoop: true,
          reason: `max ${this.maxPerMinute} loop events per minute exceeded; delaying`,
          confidence: 0.95
        }
      };
    }

    const last = recentTrace.slice(-4);
    if (last.length >= 3) {
      const sims = last.map((e) => jaccard(e.text, candidate.text));
      const repetitive = sims.filter((s) => s >= SIMILARITY_MIN).length >= 2;
      if (repetitive) {
        return {
          delayMs: this.options.delayDefaultMs,
          decision: {
            isErrorLoop: true,
            reason: 'near-identical repeated outputs detected; delayed for safety',
            confidence: 0.8
          }
        };
      }
    }

    return { delayMs: 0, decision: defaultDecision };
  }
}
