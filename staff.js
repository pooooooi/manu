const appConfig = window.APP_CONFIG || {};
const endpoint = String(appConfig.staffEndpoint || appConfig.endpoint || "").trim();
const staffToken = String(appConfig.staffToken || appConfig.apiToken || "").trim();
const isPlaceholderToken =
  staffToken === "REPLACE_WITH_ORDER_API_TOKEN" || staffToken === "REPLACE_WITH_STAFF_API_TOKEN";

const dateInput = document.getElementById("dateInput");
const refreshBtn = document.getElementById("refreshBtn");
const statusText = document.getElementById("statusText");
const ordersTabBtn = document.getElementById("ordersTabBtn");
const checkoutTabBtn = document.getElementById("checkoutTabBtn");
const ordersView = document.getElementById("ordersView");
const checkoutView = document.getElementById("checkoutView");
const ordersEl = document.getElementById("orders");
const groupsEl = document.getElementById("groups");
const paidGroupsEl = document.getElementById("paidGroups");

let activeView = "orders";
let groupLabelMap = {};

function todayText() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function setStatus(message) {
  statusText.textContent = message;
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function toGroupLetter(index) {
  // 0 -> A, 25 -> Z, 26 -> AA
  let n = Number(index) + 1;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function buildGroupLabelMapFromGroups(groups) {
  const byTable = {};
  const map = {};
  const list = Array.isArray(groups) ? groups : [];

  for (let i = 0; i < list.length; i++) {
    const table = String(list[i].table || "").trim();
    const groupId = String(list[i].groupId || "").trim();
    if (!table || !groupId) continue;
    if (!byTable[table]) byTable[table] = [];
    if (byTable[table].indexOf(groupId) < 0) byTable[table].push(groupId);
  }

  Object.keys(byTable).forEach((table) => {
    byTable[table].forEach((groupId, idx) => {
      map[`${table}::${groupId}`] = `${table}席の${toGroupLetter(idx)}グループ`;
    });
  });
  return map;
}

function getGroupLabel(table, groupId) {
  const key = `${String(table || "").trim()}::${String(groupId || "").trim()}`;
  return groupLabelMap[key] || `${String(table || "").trim()}席グループ`;
}

function jsonpFetch(url) {
  return new Promise((resolve, reject) => {
    const callbackName = `staffCb${Date.now()}${Math.floor(Math.random() * 10000)}`;
    const script = document.createElement("script");
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("timeout"));
    }, 12000);

    function cleanup() {
      window.clearTimeout(timeout);
      delete window[callbackName];
      if (script.parentNode) {
        script.parentNode.removeChild(script);
      }
    }

    window[callbackName] = (data) => {
      cleanup();
      resolve(data);
    };

    script.onerror = () => {
      cleanup();
      reject(new Error("network error"));
    };

    const sep = url.indexOf("?") >= 0 ? "&" : "?";
    script.src = `${url}${sep}callback=${callbackName}`;
    document.body.appendChild(script);
  });
}

function renderOrders(orders) {
  if (!orders || orders.length === 0) {
    ordersEl.innerHTML = '<div class="empty">未確認の注文はありません。</div>';
    return;
  }

  ordersEl.innerHTML = orders
    .map((o) => {
      const items = escapeHtml(o.items).replace(/,\s*/g, "\n");
      const groupLabel = getGroupLabel(o.table, o.groupId);
      return `
        <section class="card">
          <p class="meta">${escapeHtml(o.timestamp)} / テーブル ${escapeHtml(o.table)}</p>
          <p class="meta">${escapeHtml(groupLabel)} / 注文ID: ${escapeHtml(o.orderId)}</p>
          <p class="meta">内部ID: ${escapeHtml(o.groupId)}</p>
          <p class="items">${items}</p>
          <div class="row">
            <span class="subtotal">${Number(o.subtotal || 0)}円</span>
            <button class="confirm-btn" data-order-id="${escapeHtml(
              o.orderId
            )}" data-busy="0">確認済みにする</button>
          </div>
        </section>
      `;
    })
    .join("");
}

function renderGroups(groups) {
  if (!groups || groups.length === 0) {
    groupsEl.innerHTML = '<div class="empty">会計対象のグループはありません。</div>';
    return;
  }

  groupLabelMap = buildGroupLabelMapFromGroups(groups);

  groupsEl.innerHTML = groups
    .map((g) => {
      const groupLabel = getGroupLabel(g.table, g.groupId);
      return `
        <section class="card">
          <p class="meta">${escapeHtml(groupLabel)}</p>
          <p class="meta">内部ID: ${escapeHtml(g.groupId)}</p>
          <p class="meta">最終注文: ${escapeHtml(g.lastOrderAt)}</p>
          <p class="meta">注文数: ${Number(g.orderCount || 0)} / 状態: ${escapeHtml(g.status)}</p>
          <p class="items">${escapeHtml(g.items || "").replace(/\n/g, "<br>") || "注文内容なし"}</p>
          <div class="row">
            <span class="subtotal">合計 ${Number(g.groupTotal || 0)}円</span>
            <button
              class="pay-btn"
              data-busy="0"
              data-table="${escapeHtml(g.table)}"
              data-group-id="${escapeHtml(g.groupId)}"
            >会計済みにする</button>
          </div>
          <p class="meta">経過 ${Number(g.elapsedMin || 0)}分</p>
        </section>
      `;
    })
    .join("");
}

function renderPaidGroups(groups) {
  if (!groups || groups.length === 0) {
    paidGroupsEl.innerHTML = '<div class="empty">会計履歴はまだありません。</div>';
    return;
  }

  paidGroupsEl.innerHTML = groups
    .map((g) => {
      const groupLabel = getGroupLabel(g.table, g.groupId);
      return `
        <section class="card">
          <p class="meta">${escapeHtml(groupLabel)}</p>
          <p class="meta">内部ID: ${escapeHtml(g.groupId)}</p>
          <p class="meta">最終注文: ${escapeHtml(g.lastOrderAt)}</p>
          <p class="meta">注文数: ${Number(g.orderCount || 0)} / 状態: ${escapeHtml(g.status)}</p>
          <p class="items">${escapeHtml(g.items || "").replace(/\n/g, "<br>") || "注文内容なし"}</p>
          <div class="row">
            <span class="subtotal">合計 ${Number(g.groupTotal || 0)}円</span>
            <button
              class="pay-btn"
              data-action="undo-paid"
              data-busy="0"
              data-table="${escapeHtml(g.table)}"
              data-group-id="${escapeHtml(g.groupId)}"
            >会計取り消し</button>
          </div>
          <p class="meta">経過 ${Number(g.elapsedMin || 0)}分</p>
        </section>
      `;
    })
    .join("");
}

function validateConfig() {
  if (!endpoint) {
    setStatus("設定エラー: endpoint がありません。");
    return false;
  }
  if (!staffToken || isPlaceholderToken) {
    setStatus("設定エラー: staffToken/apiToken を実値にしてください。");
    return false;
  }
  return true;
}

async function loadOrders() {
  if (!validateConfig()) return;

  const date = dateInput.value || todayText();
  setStatus("注文一覧を読み込み中...");
  try {
    const url = `${endpoint}?action=getOrders&status=${encodeURIComponent("未確認")}&date=${encodeURIComponent(
      date
    )}&staffToken=${encodeURIComponent(staffToken)}`;
    const data = await jsonpFetch(url);
    if (!data || data.result !== "OK") {
      setStatus(`取得失敗: ${(data && data.message) || "unknown error"}`);
      return;
    }

    // 注文画面でも分かりやすい名称を出すため、同日サマリからラベルを作る。
    try {
      const summaryUrl = `${endpoint}?action=getGroupSummary&date=${encodeURIComponent(
        date
      )}&staffToken=${encodeURIComponent(staffToken)}`;
      const summary = await jsonpFetch(summaryUrl);
      if (summary && summary.result === "OK") {
        groupLabelMap = buildGroupLabelMapFromGroups(summary.groups || []);
      }
    } catch (_) {}

    renderOrders(data.orders || []);
    setStatus(`注文確認: 未確認 ${Number(data.count || 0)}件 / ${date}`);
  } catch (error) {
    console.error(error);
    setStatus("注文一覧の読み込みに失敗しました。");
  }
}

async function loadGroups() {
  if (!validateConfig()) return;

  const date = dateInput.value || todayText();
  setStatus("会計一覧を読み込み中...");
  try {
    const activeUrl = `${endpoint}?action=getGroupSummary&status=${encodeURIComponent(
      "active"
    )}&date=${encodeURIComponent(
      date
    )}&staffToken=${encodeURIComponent(staffToken)}`;
    const paidUrl = `${endpoint}?action=getGroupSummary&status=${encodeURIComponent(
      "会計済"
    )}&date=${encodeURIComponent(date)}&staffToken=${encodeURIComponent(staffToken)}`;

    const activeData = await jsonpFetch(activeUrl);
    if (!activeData || activeData.result !== "OK") {
      setStatus(`取得失敗: ${(activeData && activeData.message) || "unknown error"}`);
      return;
    }
    const paidData = await jsonpFetch(paidUrl);
    if (!paidData || paidData.result !== "OK") {
      setStatus(`取得失敗: ${(paidData && paidData.message) || "unknown error"}`);
      return;
    }

    const activeGroups = activeData.groups || [];
    const paidGroups = paidData.groups || [];
    renderGroups(activeGroups);
    renderPaidGroups(paidGroups);
    setStatus(
      `会計確認: 会計待ち ${Number(activeData.count || 0)}件 / 履歴 ${Number(
        paidData.count || 0
      )}件 / ${date}`
    );
  } catch (error) {
    console.error(error);
    setStatus("会計一覧の読み込みに失敗しました。");
  }
}

async function loadActiveView() {
  if (activeView === "checkout") {
    await loadGroups();
    return;
  }
  await loadOrders();
}

function switchView(view) {
  activeView = view === "checkout" ? "checkout" : "orders";

  const showCheckout = activeView === "checkout";
  ordersView.classList.toggle("hidden", showCheckout);
  checkoutView.classList.toggle("hidden", !showCheckout);
  ordersTabBtn.classList.toggle("is-active", !showCheckout);
  checkoutTabBtn.classList.toggle("is-active", showCheckout);

  loadActiveView();
}

async function markConfirmed(orderId, btn) {
  if (!orderId) return;
  if (!btn || btn.dataset.busy === "1") return;

  const originalText = btn.textContent;
  btn.dataset.busy = "1";
  btn.disabled = true;
  btn.textContent = "確認中...";

  const body = new URLSearchParams({
    action: "markConfirmed",
    orderId: orderId,
    date: dateInput.value || todayText(),
    staffToken: staffToken
  });

  try {
    await fetch(endpoint, {
      method: "POST",
      mode: "no-cors",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString()
    });
    const verified = await waitForOrderStatus(orderId, "確認済");
    if (!verified) {
      throw new Error("verification failed");
    }
    btn.textContent = "確認済";
    setStatus("確認状態を更新しました。再読み込みします...");
    window.setTimeout(loadActiveView, 500);
  } catch (error) {
    console.error(error);
    btn.dataset.busy = "0";
    btn.disabled = false;
    btn.textContent = originalText;
    setStatus("確認状態の更新に失敗しました。");
  }
}

async function waitForOrderStatus(orderId, expectedStatus, timeoutMs = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const date = dateInput.value || todayText();
    const url = `${endpoint}?action=checkOrder&date=${encodeURIComponent(
      date
    )}&orderId=${encodeURIComponent(orderId)}&token=${encodeURIComponent(staffToken)}`;
    const data = await jsonpFetch(url);
    if (data && data.result === "OK" && data.exists && data.status === expectedStatus) {
      return true;
    }
    await new Promise((r) => window.setTimeout(r, 700));
  }
  return false;
}

async function waitForGroupStatus(table, groupId, expectedStatus, timeoutMs = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const date = dateInput.value || todayText();
    const url = `${endpoint}?action=checkGroupStatus&date=${encodeURIComponent(
      date
    )}&table=${encodeURIComponent(table)}&groupId=${encodeURIComponent(
      groupId
    )}&staffToken=${encodeURIComponent(staffToken)}`;
    const data = await jsonpFetch(url);
    if (data && data.result === "OK" && data.status === expectedStatus) {
      return true;
    }
    await new Promise((r) => window.setTimeout(r, 700));
  }
  return false;
}

async function markGroupPaid(table, groupId, btn) {
  if (!table || !groupId) return;
  if (!btn || btn.dataset.busy === "1") return;

  const originalText = btn.textContent;
  btn.dataset.busy = "1";
  btn.disabled = true;
  btn.textContent = "会計処理中...";

  const body = new URLSearchParams({
    action: "markGroupPaid",
    table: table,
    groupId: groupId,
    date: dateInput.value || todayText(),
    staffToken: staffToken
  });

  try {
    await fetch(endpoint, {
      method: "POST",
      mode: "no-cors",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString()
    });
    const ok = await waitForGroupStatus(table, groupId, "会計済");
    if (!ok) {
      throw new Error("verification failed");
    }
    btn.textContent = "会計済";
    setStatus("会計状態を更新しました。再読み込みします...");
    window.setTimeout(loadGroups, 500);
  } catch (error) {
    console.error(error);
    btn.dataset.busy = "0";
    btn.disabled = false;
    btn.textContent = originalText;
    setStatus("会計状態の更新に失敗しました。");
  }
}

async function undoGroupPaid(table, groupId, btn) {
  if (!table || !groupId) return;
  if (!btn || btn.dataset.busy === "1") return;

  const originalText = btn.textContent;
  btn.dataset.busy = "1";
  btn.disabled = true;
  btn.textContent = "取消中...";

  const body = new URLSearchParams({
    action: "undoGroupPaid",
    table: table,
    groupId: groupId,
    date: dateInput.value || todayText(),
    staffToken: staffToken
  });

  try {
    await fetch(endpoint, {
      method: "POST",
      mode: "no-cors",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString()
    });
    const ok = await waitForGroupStatus(table, groupId, "確認済");
    if (!ok) {
      throw new Error("verification failed");
    }
    btn.textContent = "取消済";
    setStatus("会計取り消しを反映しました。再読み込みします...");
    window.setTimeout(loadGroups, 500);
  } catch (error) {
    console.error(error);
    btn.dataset.busy = "0";
    btn.disabled = false;
    btn.textContent = originalText;
    setStatus("会計取り消しに失敗しました。");
  }
}

ordersEl.addEventListener("click", (ev) => {
  const btn = ev.target.closest(".confirm-btn");
  if (!btn) return;
  markConfirmed(btn.dataset.orderId || "", btn);
});

groupsEl.addEventListener("click", (ev) => {
  const btn = ev.target.closest(".pay-btn");
  if (!btn) return;
  markGroupPaid(btn.dataset.table || "", btn.dataset.groupId || "", btn);
});

paidGroupsEl.addEventListener("click", (ev) => {
  const btn = ev.target.closest(".pay-btn");
  if (!btn) return;
  if ((btn.dataset.action || "") !== "undo-paid") return;
  undoGroupPaid(btn.dataset.table || "", btn.dataset.groupId || "", btn);
});

ordersTabBtn.addEventListener("click", () => switchView("orders"));
checkoutTabBtn.addEventListener("click", () => switchView("checkout"));
refreshBtn.addEventListener("click", loadActiveView);
dateInput.addEventListener("change", loadActiveView);

window.addEventListener("DOMContentLoaded", () => {
  dateInput.value = todayText();
  switchView("orders");
  window.setInterval(loadActiveView, 15000);
});
