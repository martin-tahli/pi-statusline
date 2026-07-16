export interface TokenUsage {
  input: number;
  output: number;
}

export type ThroughputLevel = "muted" | "success" | "warning" | "error";

export interface MeterSnapshot {
  inputRate?: number;
  outputRate?: number;
  inputLevel?: ThroughputLevel;
  outputLevel?: ThroughputLevel;
  activeMs: number;
  elapsedMs: number;
  lastTurnMs?: number;
}

export function rateLevel(rate: number, history: number[], output = false): ThroughputLevel {
  if (output && rate <= 15) return "error";
  if (history.length < 3) return "muted";
  const baseline = history.reduce((sum, value) => sum + value, 0) / history.length;
  return rate >= baseline * 0.9 ? "success" : rate >= baseline * 0.6 ? "warning" : "error";
}

function fallbackRate(tokens: number, measuredMs: number, turnMs: number): number {
  const duration = measuredMs > 0 ? measuredMs : turnMs;
  return duration > 0 ? tokens / (duration / 1_000) : 0;
}

export class TurnMeter {
  private readonly clock: () => number;
  private sessionStartedAt: number;
  private turnStartedAt?: number;
  private firstUpdateAt?: number;
  private messageEndedAt?: number;
  private inputRate?: number;
  private outputRate?: number;
  private inputLevel?: ThroughputLevel;
  private outputLevel?: ThroughputLevel;
  private inputHistory: number[] = [];
  private outputHistory: number[] = [];
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
    this.resetThroughput();
    this.activeMs = 0;
    this.lastTurnMs = undefined;
  }

  resetThroughput(): void {
    this.inputHistory = [];
    this.outputHistory = [];
    this.inputRate = undefined;
    this.outputRate = undefined;
    this.inputLevel = undefined;
    this.outputLevel = undefined;
  }

  startTurn(at = this.clock()): void {
    this.turnStartedAt = at;
    this.firstUpdateAt = undefined;
    this.messageEndedAt = undefined;
    this.inputRate = undefined;
    this.outputRate = undefined;
    this.inputLevel = undefined;
    this.outputLevel = undefined;
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
    this.inputRate = fallbackRate(usage.input, inputMs, duration);
    this.outputRate = fallbackRate(usage.output, outputMs, duration);
    this.inputLevel = rateLevel(this.inputRate, this.inputHistory);
    this.outputLevel = rateLevel(this.outputRate, this.outputHistory, true);
    this.inputHistory.push(this.inputRate);
    this.outputHistory.push(this.outputRate);
    if (this.inputHistory.length > 5) this.inputHistory.shift();
    if (this.outputHistory.length > 5) this.outputHistory.shift();
    this.turnStartedAt = undefined;
  }

  snapshot(now = this.clock()): MeterSnapshot {
    return {
      inputRate: this.inputRate,
      outputRate: this.outputRate,
      inputLevel: this.inputLevel,
      outputLevel: this.outputLevel,
      activeMs: this.activeMs,
      elapsedMs: Math.max(0, now - this.sessionStartedAt),
      lastTurnMs: this.lastTurnMs,
    };
  }
}
