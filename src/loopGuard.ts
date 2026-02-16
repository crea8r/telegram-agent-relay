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

async function llmLoopDecision(candidate: EventEnvelope, history: EventEnvelope[]): Promise<RouterDecision | null> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;

  const payload = {
    model: 'gpt-4o-mini',
    temperature: 0,
    messages: [
      {
        role: 'system',
        content:
          'Decide if this is an ERROR LOOP only (not intentional loop). Return strict JSON: {"isErrorLoop":boolean,"reason":string,"confidence":number}.'
      },
      {
        role: 'user',
        content: JSON.stringify({
          rule: 'Treat repeated near-identical outputs over multiple hops as error loop.',
          candidate,
          history: history.slice(-8)
        })
      }
    ],
    response_format: { type: 'json_object' }
  };

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!res.ok) return null;
  const json = await res.json() as any;
  const text = json?.choices?.[0]?.message?.content;
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return {
      isErrorLoop: !!parsed.isErrorLoop,
      reason: String(parsed.reason ?? 'llm decision'),
      confidence: Number(parsed.confidence ?? 0.5)
    };
  } catch {
    return null;
  }
}

export class LoopGuard {
  constructor(private store: Store, private maxPerMinute: number) {}

  async evaluate(candidate: EventEnvelope): Promise<{ delayMs: number; decision: RouterDecision }> {
    const recentTrace = this.store.recentByTrace(candidate.traceId, 60_000);

    const defaultDecision: RouterDecision = {
      isErrorLoop: false,
      reason: 'accepted',
      confidence: 0.6
    };

    // Rate limiter for burst loops: do not drop, delay posting.
    if (recentTrace.length >= this.maxPerMinute) {
      return {
        delayMs: 60_000,
        decision: {
          isErrorLoop: true,
          reason: `max ${this.maxPerMinute} loop events per minute exceeded; delaying`,
          confidence: 0.95
        }
      };
    }

    // Heuristic repetition check across few hops.
    const last = recentTrace.slice(-4);
    if (last.length >= 3) {
      const sims = last.map((e) => jaccard(e.text, candidate.text));
      const repetitive = sims.filter((s) => s >= SIMILARITY_MIN).length >= 2;
      if (repetitive) {
        const llm = await llmLoopDecision(candidate, recentTrace);
        if (llm?.isErrorLoop) {
          return { delayMs: 20_000, decision: llm };
        }
        return {
          delayMs: 10_000,
          decision: llm ?? {
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
