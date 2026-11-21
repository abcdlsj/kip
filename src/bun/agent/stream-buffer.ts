/**
 * 16ms frame coalescer for high-frequency token deltas. Batches adjacent text
 * and thinking chunks so the Electrobun IPC bridge and React render loop stay
 * smooth without delaying structural events (which flush immediately).
 */
import type { AgentStreamEvent } from "../../shared/types";
import { STREAM_FRAME_MS } from "../../shared/constants";

export type StreamEmit = (threadId: string, event: AgentStreamEvent) => void;

type DeltaKind = "text_delta" | "thinking_delta";

interface PendingDelta {
  kind: DeltaKind;
  turnId: string;
  blockId: string;
  text: string;
}

export class FrameBuffer {
  private readonly pending = new Map<string, PendingDelta>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly emit: StreamEmit,
    private readonly threadId: string,
    private readonly frameMs = STREAM_FRAME_MS,
  ) {}

  push(kind: DeltaKind, turnId: string, blockId: string, delta: string): void {
    if (!delta) return;
    const key = `${kind}:${turnId}:${blockId}`;
    const existing = this.pending.get(key);
    if (existing) {
      existing.text += delta;
    } else {
      this.pending.set(key, { kind, turnId, blockId, text: delta });
    }
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.frameMs);
    }
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending.size === 0) return;
    for (const value of this.pending.values()) {
      this.emit(this.threadId, {
        kind: value.kind,
        turnId: value.turnId,
        blockId: value.blockId,
        delta: value.text,
      });
    }
    this.pending.clear();
  }

  clear(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending.clear();
  }

  get hasPending(): boolean {
    return this.pending.size > 0;
  }
}
