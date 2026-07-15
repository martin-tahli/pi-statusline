import assert from "node:assert/strict";
import test from "node:test";
import { TurnMeter } from "../src/throughput.ts";

test("measures prompt/generation windows and guards zero duration", () => {
  const meter = new TurnMeter(() => 0);
  meter.startTurn(0);
  meter.markFirstUpdate(10_000);
  meter.markMessageEnd(20_000);
  meter.finishTurn({ input: 8_500, output: 620 }, 20_000);
  assert.equal(meter.snapshot(20_000).inputRate, 850);
  assert.equal(meter.snapshot(20_000).outputRate, 62);

  meter.startTurn(20_000);
  meter.markFirstUpdate(20_000);
  meter.markMessageEnd(20_000);
  meter.finishTurn({ input: 10, output: 10 }, 20_000);
  assert.equal(meter.snapshot(20_000).inputRate, undefined);
  assert.equal(meter.snapshot(20_000).outputRate, undefined);
});

test("retains idle result, resets on turn start, and accumulates active time", () => {
  const meter = new TurnMeter(() => 1_000);
  assert.equal(meter.snapshot(1_000).lastTurnMs, undefined);
  for (const [start, duration] of [[1_000, 5_000], [7_000, 10_000], [20_000, 3_000]] as const) {
    meter.startTurn(start);
    meter.markFirstUpdate(start + 1_000);
    meter.markMessageEnd(start + duration);
    meter.finishTurn({ input: 100, output: 100 }, start + duration);
  }
  const idle = meter.snapshot(30_000);
  assert.equal(idle.activeMs, 18_000);
  assert.equal(idle.lastTurnMs, 3_000);
  assert.equal(idle.elapsedMs, 29_000);
  assert.ok(idle.outputRate);

  meter.startTurn(31_000);
  assert.equal(meter.snapshot(31_000).outputRate, undefined);
  meter.finishTurn({ input: 0, output: 0 }, 35_000);
  assert.equal(meter.snapshot(35_000).activeMs, 22_000);
});
