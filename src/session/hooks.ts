import type { SessionEntity } from "./entity.ts";
import type { SessionStatus } from "../domain/types.ts";
import type { Store } from "../persistence/store.ts";

/** Optional observers; required state writes are explicitly awaited by the owner. */
export interface SessionLifecycleHook {
  onTurnStarted?(session: SessionEntity, turnId: string, input: string): Promise<void> | void;
  onTurnCompleted?(
    session: SessionEntity,
    turnId: string,
    status: "completed" | "failed" | "interrupted",
  ): Promise<void> | void;
  onStateChanged?(
    session: SessionEntity,
    from: SessionStatus,
    to: SessionStatus,
  ): Promise<void> | void;
  onCursorAck?(session: SessionEntity, source: string, sequence: number): void;
  onDestroyed?(session: SessionEntity): Promise<void> | void;
}
export type SessionObserver = (
  event:
    | { type: "state.changed"; session: SessionEntity; from: SessionStatus; to: SessionStatus }
    | { type: "turn.started"; session: SessionEntity; turnId: string; input: string }
    | {
        type: "turn.completed";
        session: SessionEntity;
        turnId: string;
        status: "completed" | "failed" | "interrupted";
      }
    | { type: "cursor.advanced"; session: SessionEntity; source: string; sequence: number }
    | { type: "destroyed"; session: SessionEntity },
) => void | Promise<void>;

export class PersistenceCheckpointHook implements SessionLifecycleHook {
  constructor(private readonly store: Store) {}
  async onTurnCompleted(session: SessionEntity): Promise<void> {
    await session.flush(this.store);
  }
  async onStateChanged(session: SessionEntity): Promise<void> {
    await session.flush(this.store);
  }
}
