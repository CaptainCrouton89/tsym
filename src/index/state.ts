import type { BuiltIndex } from './build.js';

export type IndexStatus = 'current' | 'indexing' | 'stale';

export interface IndexSnapshot {
  indexedAt: string;
  state: IndexStatus;
  built: BuiltIndex;
}

/** Serializes index rebuilds and exposes only a completed index to store readers. */
export class IndexStateController {
  private snapshot: IndexSnapshot;
  private pending: Promise<void> | undefined;
  private startStale: (() => Promise<void>) | undefined;
  private staleGeneration = 0;

  constructor(initial: IndexSnapshot, private readonly publish: (snapshot: IndexSnapshot) => void) {
    this.snapshot = initial;
    publish(initial);
  }

  current(): IndexSnapshot { return this.snapshot; }

  markStale(start: () => Promise<void>): void {
    this.staleGeneration++;
    this.startStale = start;
    if (!this.pending) this.set({ ...this.snapshot, state: 'stale' });
  }

  rebuild(work: () => Promise<IndexSnapshot>): Promise<void> {
    const run = async () => {
      const generation = this.staleGeneration;
      this.set({ ...this.snapshot, state: 'indexing' });
      try {
        const next = await work();
        if (generation !== this.staleGeneration) this.set({ ...next, state: 'stale' });
        else {
          this.startStale = undefined;
          this.set(next);
        }
      } catch (error) {
        this.set({ ...this.snapshot, state: 'stale' });
        throw error;
      }
    };
    const previous = this.pending ?? Promise.resolve();
    const tracked: Promise<void> = previous.then(run, run).finally(() => { if (this.pending === tracked) this.pending = undefined; });
    this.pending = tracked;
    return tracked;
  }

  /** Resolves against a completed index, forcing the watcher's pending batch rather than waiting out its debounce. */
  async wait(): Promise<IndexSnapshot> {
    for (;;) {
      if (this.snapshot.state === 'stale') {
        const start = this.startStale;
        if (!start) throw new Error('The index is stale and no rebuild is scheduled.');
        await start();
      } else if (this.pending) await this.pending;
      else return this.snapshot;
    }
  }

  private set(snapshot: IndexSnapshot): void {
    this.snapshot = snapshot;
    this.publish(snapshot);
  }
}
