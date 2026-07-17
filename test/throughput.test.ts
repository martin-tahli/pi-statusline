import assert from "node:assert/strict";
import test from "node:test";
import { estimateTokens, rateLevel, sumTextLength, TurnMeter } from "../src/throughput.ts";

test("estimates tokens from character counts for providers that omit usage", () => {
  assert.equal(estimateTokens(0), 0);
  assert.equal(estimateTokens(3), 1);
  assert.equal(estimateTokens(400), 100);
});

test("sums text across nested message content, ignoring non-text fields", () => {
  assert.equal(sumTextLength("abcd"), 4);
  assert.equal(sumTextLength([{ type: "text", text: "ab" }, { type: "thinking", thinking: "cde" }]), 5);
  assert.equal(sumTextLength({ role: "user", content: [{ type: "text", text: "abcdefgh" }] }), 8);
  assert.equal(sumTextLength([{ role: "assistant", content: "hi" }, { role: "toolResult", toolCallId: "1" }]), 2);
  assert.equal(sumTextLength(undefined), 0);
});

test("measures streamed windows and independently falls back to the whole turn", () => {
  const meter = new TurnMeter(() => 0);
  meter.startTurn(0);
  meter.markFirstUpdate(10_000);
  meter.markMessageEnd(20_000);
  meter.finishTurn({ input: 8_500, output: 620 }, 20_000);
  assert.equal(meter.snapshot(20_000).inputRate, 850);
  assert.equal(meter.snapshot(20_000).outputRate, 62);

  meter.startTurn(20_000);
  meter.finishTurn({ input: 100, output: 200 }, 30_000);
  assert.equal(meter.snapshot(30_000).inputRate, 10);
  assert.equal(meter.snapshot(30_000).outputRate, 20);

  meter.startTurn(30_000);
  meter.finishTurn({ input: 10, output: 10 }, 30_000);
  assert.equal(meter.snapshot(30_000).inputRate, 0);
  assert.equal(meter.snapshot(30_000).outputRate, 0);
});

test("classifies rates with directional baselines and an output floor", () => {
  assert.equal(rateLevel(68, [70, 71, 69, 70, 70]), "success");
  assert.equal(rateLevel(48, [70, 71, 69, 70, 70]), "warning");
  assert.equal(rateLevel(30, [70, 71, 69, 70, 70]), "error");
  assert.equal(rateLevel(1_000, [1_200, 1_200, 1_200]), "warning");
  assert.equal(rateLevel(100, [100, 100]), "muted");
  assert.equal(rateLevel(15, [], true), "error");
});

test("caps histories and resets displayed throughput on model changes", () => {
  const meter = new TurnMeter(() => 0);
  const finish = (start: number, rate: number) => {
    meter.startTurn(start);
    meter.finishTurn({ input: rate, output: rate }, start + 1_000);
  };
  for (let turn = 0; turn < 5; turn++) finish(turn * 1_000, 100);
  finish(5_000, 0);
  finish(6_000, 73);
  assert.equal(meter.snapshot(7_000).inputLevel, "success");

  meter.resetThroughput();
  assert.equal(meter.snapshot(7_000).inputRate, undefined);
  finish(7_000, 10);
  assert.equal(meter.snapshot(8_000).inputLevel, "muted");
  assert.equal(meter.snapshot(8_000).outputLevel, "error");
});

test("finalizes active time without preserving rates", () => {
  const meter = new TurnMeter(() => 0);
  meter.startTurn(1_000);
  assert.equal(meter.liveElapsedMs(2_000), 1_000);
  meter.finalizeActiveTurn(4_000);
  assert.equal(meter.liveElapsedMs(5_000), 0);
  assert.equal(meter.snapshot(5_000).activeMs, 3_000);
  assert.equal(meter.snapshot(5_000).lastTurnMs, 3_000);
  assert.equal(meter.snapshot(5_000).inputRate, undefined);
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
