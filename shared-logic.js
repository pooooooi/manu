(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
    return;
  }
  root.ManuSharedLogic = Object.assign(root.ManuSharedLogic || {}, factory());
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const STATUS_UNCONFIRMED = "\u672A\u78BA\u8A8D";
  const STATUS_PAID = "\u4F1A\u8A08\u6E08";
  const STATUS_CANCELLED = "\u53D6\u6D88\u6E08";

  function countCheckoutWaitingGroups(groups) {
    const list = Array.isArray(groups) ? groups : [];
    let count = 0;
    for (let i = 0; i < list.length; i++) {
      const g = list[i] || {};
      const status = String(g.status || "").trim();
      if (status === STATUS_CANCELLED) continue;
      if (status === STATUS_PAID) continue;
      const total = Number(g.groupTotal) || 0;
      const orderCount = Number(g.orderCount) || 0;
      if (total <= 0 && orderCount <= 0 && status !== STATUS_UNCONFIRMED) continue;
      count++;
    }
    return count;
  }

  function makeHistoryStatusKey(dateText, orderId) {
    const date = String(dateText || "").trim();
    const id = String(orderId || "").trim();
    return `${date}::${id}`;
  }

  function filterOutCanceledHistoryEntries(entries, statusByKey) {
    const list = Array.isArray(entries) ? entries : [];
    const map = statusByKey && typeof statusByKey === "object" ? statusByKey : {};
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const entry = list[i] || {};
      const orderId = String(entry.orderId || "").trim();
      const dateText = String(entry.date || "").trim();
      if (!orderId || !dateText) {
        out.push(entry);
        continue;
      }
      const key = makeHistoryStatusKey(dateText, orderId);
      const status = String(map[key] || "").trim();
      if (status === STATUS_CANCELLED) continue;
      out.push(entry);
    }
    return out;
  }

  return {
    countCheckoutWaitingGroups: countCheckoutWaitingGroups,
    makeHistoryStatusKey: makeHistoryStatusKey,
    filterOutCanceledHistoryEntries: filterOutCanceledHistoryEntries
  };
});
