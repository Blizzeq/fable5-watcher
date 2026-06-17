import { test } from "node:test";
import assert from "node:assert/strict";
import { decide } from "../src/index.js";

const HOUR = 60 * 60 * 1000;
const cfg = { confirmUp: 2, confirmDown: 1, heartbeatMs: 3 * HOUR, unknownAlertChecks: 15 };

const base = (over = {}) => ({
  status: "",
  upStreak: 0,
  downStreak: 0,
  lastDownPing: 0,
  unknownStreak: 0,
  unknownAlerted: 0,
  ...over,
});

test("first reading down arms the watcher", () => {
  const now = 1000;
  const { state, notifications } = decide({ reading: "down", prev: base(), now, cfg });
  assert.deepEqual(notifications, ["armed"]);
  assert.equal(state.status, "down");
  assert.equal(state.lastDownPing, now);
});

test("recovery requires confirmUp consecutive reads", () => {
  const prev = base({ status: "down", downStreak: 5, lastDownPing: 1 });
  const first = decide({ reading: "up", prev, now: 10, cfg });
  assert.deepEqual(first.notifications, []);
  assert.equal(first.state.status, "down");
  assert.equal(first.state.upStreak, 1);

  const second = decide({ reading: "up", prev: first.state, now: 20, cfg });
  assert.deepEqual(second.notifications, ["up"]);
  assert.equal(second.state.status, "up");
});

test("going down from up notifies once", () => {
  const prev = base({ status: "up", upStreak: 9 });
  const { state, notifications } = decide({ reading: "down", prev, now: 50, cfg });
  assert.deepEqual(notifications, ["down"]);
  assert.equal(state.status, "down");
  assert.equal(state.lastDownPing, 50);
});

test("heartbeat fires only after the interval while still down", () => {
  const prev = base({ status: "down", downStreak: 3, lastDownPing: 0 });
  const early = decide({ reading: "down", prev, now: 2 * HOUR, cfg });
  assert.deepEqual(early.notifications, []);

  const late = decide({ reading: "down", prev, now: 3 * HOUR + 1, cfg });
  assert.deepEqual(late.notifications, ["heartbeat"]);
  assert.equal(late.state.lastDownPing, 3 * HOUR + 1);
});

test("staying up stays silent", () => {
  const prev = base({ status: "up", upStreak: 4 });
  const { notifications } = decide({ reading: "up", prev, now: 100, cfg });
  assert.deepEqual(notifications, []);
});

test("a single unknown read changes nothing and never notifies below threshold", () => {
  const prev = base({ status: "down", downStreak: 2, lastDownPing: 1 });
  const { state, notifications } = decide({ reading: "unknown", prev, now: 100, cfg });
  assert.deepEqual(notifications, []);
  assert.equal(state.status, "down");
  assert.equal(state.unknownStreak, 1);
});

test("blind alert fires once at the threshold and does not repeat", () => {
  let state = base({ status: "down", unknownStreak: 14 });
  const atThreshold = decide({ reading: "unknown", prev: state, now: 1, cfg });
  assert.deepEqual(atThreshold.notifications, ["blind"]);
  assert.equal(atThreshold.state.unknownAlerted, 1);

  const next = decide({ reading: "unknown", prev: atThreshold.state, now: 2, cfg });
  assert.deepEqual(next.notifications, []);
});

test("a known read clears the unknown tracking", () => {
  const prev = base({ status: "down", unknownStreak: 20, unknownAlerted: 1 });
  const { state } = decide({ reading: "down", prev, now: 5, cfg });
  assert.equal(state.unknownStreak, 0);
  assert.equal(state.unknownAlerted, 0);
});
