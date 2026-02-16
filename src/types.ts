export type ActorType = 'human' | 'agent' | 'system';

export interface EventEnvelope {
  eventId: string;
  traceId: string;
  sessionKey: string;
  sourceChannel: string;
  sourceChatId: string;
  sourceThreadId: string;
  sourceMessageId: string;
  originActorType: ActorType;
  originActorId: string;
  text: string;
  hopCount: number;
  seenAgents: string[];
  createdAt: number;
  emittedByAgentId?: string;
  emittedEventId?: string;
}

export interface RouterDecision {
  isErrorLoop: boolean;
  reason: string;
  confidence: number;
}
