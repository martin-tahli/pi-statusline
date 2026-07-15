export interface TokenUsage {
  input: number;
  output: number;
}

export interface MeterSnapshot {
  inputRate?: number;
  outputRate?: number;
  activeMs: number;
  elapsedMs: number;
  lastTurnMs?: number;
}

export class TurnMeter {
  private readonly clock: () => number;
  private sessionStartedAt: number;
  private turnStartedAt?: number;
  private firstUpdateAt?: number;
  private messageEndedAt?: number;
  private inputRate?: number;
  private outputRate?: number;
  private activeMs = 0;
  private lastTurnMs?: number;

  constructor(clock: () => number = Date.now) {
    this.clock = clock;
    this.sessionStartedAt = clock();
  }

  resetSession(at = this.clock()): void {
    this.sessionStartedAt = at;
    this.turnStartedAt = undefined;
    this.firstUpdateAt = undefined;
    this.messageEndedAt = undefined;
    this.inputRate = undefined;
    this.outputRate = undefined;
    this.activeMs = 0;
    this.lastTurnMs = undefined;
  }

  startTurn(at = this.clock()): void {
    this.turnStartedAt = at;
    this.firstUpdateAt = undefined;
    this.messageEndedAt = undefined;
    this.inputRate = undefined;
    this.outputRate = undefined;
  }

  markFirstUpdate(at = this.clock()): void {
    this.firstUpdateAt ??= at;
  }

  markMessageEnd(at = this.clock()): void {
    this.messageEndedAt = at;
  }

  finishTurn(usage: TokenUsage, at = this.clock()): void {
    if (this.turnStartedAt === undefined) return;
    const duration = Math.max(0, at - this.turnStartedAt);
    this.activeMs += duration;
    this.lastTurnMs = duration;

    const inputMs = this.firstUpdateAt === undefined ? 0 : this.firstUpdateAt - this.turnStartedAt;
    const outputMs = this.firstUpdateAt === undefined || this.messageEndedAt === undefined
      ? 0
      : this.messageEndedAt - this.firstUpdateAt;
    this.inputRate = inputMs > 0 ? usage.input / (inputMs / 1_000) : undefined;
    this.outputRate = outputMs > 0 ? usage.output / (outputMs / 1_000) : undefined;
    this.turnStartedAt = undefined;
  }

  snapshot(now = this.clock()): MeterSnapshot {
    return {
      inputRate: this.inputRate,
      outputRate: this.outputRate,
      activeMs: this.activeMs,
      elapsedMs: Math.max(0, now - this.sessionStartedAt),
      lastTurnMs: this.lastTurnMs,
    };
  }
}
