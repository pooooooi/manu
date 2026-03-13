const test = require("node:test");
const assert = require("node:assert/strict");

const {
  countCheckoutWaitingGroups,
  makeHistoryStatusKey,
  filterOutCanceledHistoryEntries
} = require("../shared-logic.js");

const STATUS_UNCONFIRMED = "\u672A\u78BA\u8A8D";
const STATUS_CONFIRMED = "\u78BA\u8A8D\u6E08";
const STATUS_PAID = "\u4F1A\u8A08\u6E08";
const STATUS_CANCELLED = "\u53D6\u6D88\u6E08";

test("countCheckoutWaitingGroups follows active-filter semantics", () => {
  const groups = [
    { status: STATUS_PAID, groupTotal: 1000, orderCount: 1 },
    { status: STATUS_CONFIRMED, groupTotal: 0, orderCount: 0 },
    { status: STATUS_UNCONFIRMED, groupTotal: 0, orderCount: 0 },
    { status: STATUS_CONFIRMED, groupTotal: 500, orderCount: 0 },
    { status: STATUS_CONFIRMED, groupTotal: 0, orderCount: 2 }
  ];

  assert.equal(countCheckoutWaitingGroups(groups), 3);
});

test("countCheckoutWaitingGroups handles empty and invalid input", () => {
  assert.equal(countCheckoutWaitingGroups(), 0);
  assert.equal(countCheckoutWaitingGroups(null), 0);
  assert.equal(countCheckoutWaitingGroups({}), 0);
});

test("countCheckoutWaitingGroups excludes non-unconfirmed zero-or-negative groups", () => {
  const groups = [
    { status: STATUS_CONFIRMED, groupTotal: -100, orderCount: 0 },
    { status: STATUS_CONFIRMED, groupTotal: 0, orderCount: 0 },
    { status: STATUS_UNCONFIRMED, groupTotal: 0, orderCount: 0 }
  ];
  assert.equal(countCheckoutWaitingGroups(groups), 1);
});

test("makeHistoryStatusKey returns stable key", () => {
  assert.equal(makeHistoryStatusKey("2026-03-14", "o-123"), "2026-03-14::o-123");
});

test("makeHistoryStatusKey trims both values", () => {
  assert.equal(makeHistoryStatusKey(" 2026-03-14 ", " o-123 "), "2026-03-14::o-123");
});

test("filterOutCanceledHistoryEntries removes only cancelled entries", () => {
  const entries = [
    { date: "2026-03-14", orderId: "o-1", items: "A x 1", total: 100 },
    { date: "2026-03-14", orderId: "o-2", items: "B x 1", total: 200 },
    { date: "2026-03-14", items: "legacy", total: 300 }
  ];

  const statusByKey = {
    [makeHistoryStatusKey("2026-03-14", "o-1")]: STATUS_CANCELLED,
    [makeHistoryStatusKey("2026-03-14", "o-2")]: STATUS_CONFIRMED
  };

  const out = filterOutCanceledHistoryEntries(entries, statusByKey);
  assert.equal(out.length, 2);
  assert.deepEqual(
    out.map((e) => String(e.orderId || "")),
    ["o-2", ""]
  );
});

test("filterOutCanceledHistoryEntries keeps entries when status is missing", () => {
  const entries = [{ date: "2026-03-14", orderId: "o-1" }];
  const out = filterOutCanceledHistoryEntries(entries, {});
  assert.equal(out.length, 1);
  assert.equal(out[0].orderId, "o-1");
});

test("filterOutCanceledHistoryEntries tolerates invalid map input", () => {
  const entries = [{ date: "2026-03-14", orderId: "o-1" }];
  const out = filterOutCanceledHistoryEntries(entries, null);
  assert.equal(out.length, 1);
  assert.equal(out[0].orderId, "o-1");
});
