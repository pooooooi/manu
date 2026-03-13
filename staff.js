const appConfig = window.APP_CONFIG || {};
const endpoint = String(appConfig.staffEndpoint || appConfig.endpoint || "").trim();
const staffToken = String(appConfig.staffToken || appConfig.apiToken || "").trim();
const isPlaceholderToken =
  staffToken === "REPLACE_WITH_ORDER_API_TOKEN" || staffToken === "REPLACE_WITH_STAFF_API_TOKEN";
const showTechnicalIds = Number.parseInt(String(appConfig.showTechnicalIds || "0"), 10) === 1;
const newOrderSoundEnabled = String(appConfig.staffNewOrderSoundEnabled || "1").trim() !== "0";
const desktopNotificationEnabled =
  String(appConfig.staffDesktopNotificationEnabled || "1").trim() !== "0";
const titleBadgeEnabled = String(appConfig.staffTitleBadgeEnabled || "1").trim() !== "0";
const jsonpTimeoutMs = Math.max(1500, Number.parseInt(String(appConfig.staffJsonpTimeoutMs || "5000"), 10) || 5000);
const verifyTimeoutMs = Math.max(2000, Number.parseInt(String(appConfig.staffVerifyTimeoutMs || "7000"), 10) || 7000);
const verifyPollIntervalMs = Math.max(
  150,
  Number.parseInt(String(appConfig.staffVerifyPollIntervalMs || "350"), 10) || 350
);
const autoRefreshIntervalMs = Math.max(
  2000,
  Number.parseInt(String(appConfig.staffAutoRefreshIntervalMs || "2000"), 10) || 2000
);

const dateInput = document.getElementById("dateInput");
const refreshBtn = document.getElementById("refreshBtn");
const statusText = document.getElementById("statusText");
const ordersTabBtn = document.getElementById("ordersTabBtn");
const ordersTabBadge = document.getElementById("ordersTabBadge");
const checkoutTabBtn = document.getElementById("checkoutTabBtn");
const checkoutTabBadge = document.getElementById("checkoutTabBadge");
const ordersView = document.getElementById("ordersView");
const checkoutView = document.getElementById("checkoutView");
const ordersEl = document.getElementById("orders");
const confirmedOrdersEl = document.getElementById("confirmedOrders");
const groupsEl = document.getElementById("groups");
const paidGroupsEl = document.getElementById("paidGroups");

let activeView = "orders";
let groupLabelMap = {};
let unconfirmedSeenDate = "";
let unconfirmedInitialized = false;
let alertTabTimer = 0;
let soundUnlocked = false;
let alertAudioContext = null;
const seenUnconfirmedKeys = new Set();
const baseTitle = document.title || "スタッフ確認画面";
const pendingOrderActions = new Map();
const pendingGroupActions = new Map();

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

function updateUnconfirmedBadge(count) {
  const n = Math.max(0, Number(count) || 0);
  if (ordersTabBadge) {
    if (n > 0) {
      ordersTabBadge.textContent = n > 99 ? "99+" : String(n);
      ordersTabBadge.classList.remove("hidden");
    } else {
      ordersTabBadge.classList.add("hidden");
    }
  }
  if (titleBadgeEnabled) {
    document.title = n > 0 ? `(${n}) ${baseTitle}` : baseTitle;
  }
}

function updateCheckoutBadge(count) {
  const n = Math.max(0, Number(count) || 0);
  if (!checkoutTabBadge) return;
  if (n > 0) {
    checkoutTabBadge.textContent = n > 99 ? "99+" : String(n);
    checkoutTabBadge.classList.remove("hidden");
    return;
  }
  checkoutTabBadge.classList.add("hidden");
}

function flashOrdersTabAlert() {
  ordersTabBtn.classList.remove("has-alert");
  if (alertTabTimer) window.clearTimeout(alertTabTimer);
  void ordersTabBtn.offsetWidth;
  ordersTabBtn.classList.add("has-alert");
  alertTabTimer = window.setTimeout(() => {
    ordersTabBtn.classList.remove("has-alert");
    alertTabTimer = 0;
  }, 1700);
}

function maybePlayNewOrderSound() {
  if (!newOrderSoundEnabled || !soundUnlocked) return;
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return;
  try {
    if (!alertAudioContext) {
      alertAudioContext = new AudioCtx();
    }
    if (alertAudioContext.state === "suspended") {
      alertAudioContext.resume().catch(() => {});
    }
    const ctx = alertAudioContext;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(1046, now);
    osc.frequency.linearRampToValueAtTime(1318, now + 0.08);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.12, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.2);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.21);
  } catch (_) {}
}

function maybeNotifyNewOrders(newOrders, totalUnconfirmed) {
  if (!desktopNotificationEnabled) return;
  if (!("Notification" in window)) return;
  if (Notification.permission !== "granted") return;
  if (document.visibilityState === "visible" && activeView === "orders") return;
  const first = (Array.isArray(newOrders) && newOrders[0]) || {};
  const table = String(first.table || "").trim();
  const body =
    `${newOrders.length}件の新規注文 / 未確認合計 ${Math.max(0, Number(totalUnconfirmed) || 0)}件` +
    (table ? ` / ${table}席` : "");
  try {
    new Notification("新規注文が入りました", { body });
  } catch (_) {}
}

function unlockAlertsByUserGesture() {
  soundUnlocked = true;
  if (desktopNotificationEnabled && "Notification" in window && Notification.permission === "default") {
    Notification.requestPermission().catch(() => {});
  }
  window.removeEventListener("pointerdown", unlockAlertsByUserGesture);
  window.removeEventListener("keydown", unlockAlertsByUserGesture);
}

function detectAndAlertNewUnconfirmed(unconfirmedOrders, dateText) {
  const date = String(dateText || "").trim();
  if (date && date !== unconfirmedSeenDate) {
    seenUnconfirmedKeys.clear();
    unconfirmedInitialized = false;
    unconfirmedSeenDate = date;
  }

  const list = Array.isArray(unconfirmedOrders) ? unconfirmedOrders : [];
  const newOrders = [];
  for (let i = 0; i < list.length; i++) {
    const o = list[i] || {};
    const key = makeOrderKey(o.orderId, o.table);
    if (!key || key === "::") continue;
    if (!unconfirmedInitialized) {
      seenUnconfirmedKeys.add(key);
      continue;
    }
    if (seenUnconfirmedKeys.has(key)) continue;
    seenUnconfirmedKeys.add(key);
    newOrders.push(o);
  }
  if (!unconfirmedInitialized) {
    unconfirmedInitialized = true;
    return;
  }
  if (newOrders.length === 0) return;
  flashOrdersTabAlert();
  maybePlayNewOrderSound();
  maybeNotifyNewOrders(newOrders, list.length);
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

function toDisplayOrderNo(orderId) {
  const raw = String(orderId || "").trim();
  if (!raw) return "-";
  return raw.length <= 8 ? raw : raw.slice(-8);
}

function toStaffStatusLabel(status) {
  const s = String(status || "").trim();
  if (s === "未確認") return "未確認あり";
  if (s === "確認済") return "確認済";
  if (s === "会計済") return "会計済";
  return s || "-";
}

function renderTechnicalMeta(orderId, groupId) {
  if (!showTechnicalIds) return "";
  return `<p class="meta">管理用: 注文ID ${escapeHtml(orderId)} / グループID ${escapeHtml(groupId)}</p>`;
}

function makeGroupKey(table, groupId) {
  return `${String(table || "").trim()}::${String(groupId || "").trim()}`;
}

function makeOrderKey(orderId, table) {
  return `${String(orderId || "").trim()}::${String(table || "").trim()}`;
}

function setPendingOrderAction(orderId, table, expectedStatuses) {
  const key = makeOrderKey(orderId, table);
  const list = Array.isArray(expectedStatuses) ? expectedStatuses : [expectedStatuses];
  pendingOrderActions.set(key, {
    expectedStatuses: list.map((s) => String(s || "").trim()).filter(Boolean)
  });
}

function getPendingOrderAction(orderId, table) {
  return pendingOrderActions.get(makeOrderKey(orderId, table)) || null;
}

function clearPendingOrderAction(orderId, table) {
  pendingOrderActions.delete(makeOrderKey(orderId, table));
}

function reconcilePendingOrderActions(unconfirmedOrders, confirmedOrders) {
  const statusByKey = {};
  const allOrders = []
    .concat(Array.isArray(unconfirmedOrders) ? unconfirmedOrders : [])
    .concat(Array.isArray(confirmedOrders) ? confirmedOrders : []);
  for (let i = 0; i < allOrders.length; i++) {
    const order = allOrders[i] || {};
    statusByKey[makeOrderKey(order.orderId, order.table)] = String(order.status || "").trim();
  }
  pendingOrderActions.forEach((entry, key) => {
    const current = String(statusByKey[key] || "").trim();
    if (!current) return;
    if ((entry.expectedStatuses || []).indexOf(current) >= 0) {
      pendingOrderActions.delete(key);
    }
  });
}

function setPendingGroupAction(table, groupId, expectedStatuses) {
  const key = makeGroupKey(table, groupId);
  const list = Array.isArray(expectedStatuses) ? expectedStatuses : [expectedStatuses];
  pendingGroupActions.set(key, {
    expectedStatuses: list.map((s) => String(s || "").trim()).filter(Boolean)
  });
}

function getPendingGroupAction(table, groupId) {
  return pendingGroupActions.get(makeGroupKey(table, groupId)) || null;
}

function clearPendingGroupAction(table, groupId) {
  pendingGroupActions.delete(makeGroupKey(table, groupId));
}

function reconcilePendingGroupActions(activeGroups, paidGroups) {
  const statusByKey = {};
  const allGroups = []
    .concat(Array.isArray(activeGroups) ? activeGroups : [])
    .concat(Array.isArray(paidGroups) ? paidGroups : []);
  for (let i = 0; i < allGroups.length; i++) {
    const group = allGroups[i] || {};
    statusByKey[makeGroupKey(group.table, group.groupId)] = String(group.status || "").trim();
  }
  pendingGroupActions.forEach((entry, key) => {
    const current = String(statusByKey[key] || "").trim();
    if (!current) return;
    if ((entry.expectedStatuses || []).indexOf(current) >= 0) {
      pendingGroupActions.delete(key);
    }
  });
}

function jsonpFetch(url) {
  return new Promise((resolve, reject) => {
    const callbackName = `staffCb${Date.now()}${Math.floor(Math.random() * 10000)}`;
    const script = document.createElement("script");
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("timeout"));
    }, jsonpTimeoutMs);

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
      const pending = getPendingOrderAction(o.orderId, o.table);
      const displayOrderNo = toDisplayOrderNo(o.orderId);
      return `
        <section class="card">
          <p class="meta">${escapeHtml(o.timestamp)} / ${escapeHtml(groupLabel)}</p>
          <p class="meta">注文No: ${escapeHtml(displayOrderNo)} / テーブル ${escapeHtml(o.table)}</p>
          <p class="meta">グループ計: ${Number(o.groupTotal || 0)}円</p>
          ${renderTechnicalMeta(o.orderId, o.groupId)}
          <p class="items">${items}</p>
          <div class="row">
            <span class="subtotal">${Number(o.subtotal || 0)}円</span>
            <button class="confirm-btn" data-order-id="${escapeHtml(
              o.orderId
            )}" data-table="${escapeHtml(o.table)}" data-busy="${pending ? "1" : "0"}" ${
              pending ? "disabled" : ""
            }>${pending ? "反映待ち..." : "確認済みにする"}</button>
          </div>
        </section>
      `;
    })
    .join("");
}

function renderConfirmedOrders(orders) {
  if (!orders || orders.length === 0) {
    confirmedOrdersEl.innerHTML = '<div class="empty">処理済み履歴はありません。</div>';
    return;
  }

  confirmedOrdersEl.innerHTML = orders
    .map((o) => {
      const items = escapeHtml(o.items).replace(/,\s*/g, "\n");
      const groupLabel = getGroupLabel(o.table, o.groupId);
      const displayOrderNo = toDisplayOrderNo(o.orderId);
      return `
        <section class="card">
          <p class="meta">${escapeHtml(o.timestamp)} / ${escapeHtml(groupLabel)}</p>
          <p class="meta">注文No: ${escapeHtml(displayOrderNo)} / テーブル ${escapeHtml(o.table)}</p>
          <p class="meta">状態: ${escapeHtml(toStaffStatusLabel(o.status || "確認済"))}</p>
          ${renderTechnicalMeta(o.orderId, o.groupId)}
          <p class="items">${items}</p>
          <div class="row">
            <span class="subtotal">${Number(o.subtotal || 0)}円</span>
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

  groupsEl.innerHTML = groups
    .map((g) => {
      const groupLabel = getGroupLabel(g.table, g.groupId);
      const pending = getPendingGroupAction(g.table, g.groupId);
      return `
        <section class="card">
          <p class="meta">${escapeHtml(groupLabel)}</p>
          <p class="meta">最終注文: ${escapeHtml(g.lastOrderAt)} / 経過 ${Number(g.elapsedMin || 0)}分</p>
          <p class="meta">注文数: ${Number(g.orderCount || 0)} / 状態: ${escapeHtml(
            toStaffStatusLabel(g.status)
          )}</p>
          ${showTechnicalIds ? `<p class="meta">管理用グループID: ${escapeHtml(g.groupId)}</p>` : ""}
          <p class="items">${escapeHtml(g.items || "").replace(/\n/g, "<br>") || "注文内容なし"}</p>
          <div class="row">
            <span class="subtotal">合計 ${Number(g.groupTotal || 0)}円</span>
            <button
              class="pay-btn"
              data-busy="${pending ? "1" : "0"}"
              data-table="${escapeHtml(g.table)}"
              data-group-id="${escapeHtml(g.groupId)}"
              ${pending ? "disabled" : ""}
            >${pending ? "反映待ち..." : "会計済みにする"}</button>
          </div>
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
      const pending = getPendingGroupAction(g.table, g.groupId);
      return `
        <section class="card">
          <p class="meta">${escapeHtml(groupLabel)}</p>
          <p class="meta">最終注文: ${escapeHtml(g.lastOrderAt)} / 経過 ${Number(g.elapsedMin || 0)}分</p>
          <p class="meta">注文数: ${Number(g.orderCount || 0)} / 状態: ${escapeHtml(
            toStaffStatusLabel(g.status)
          )}</p>
          ${showTechnicalIds ? `<p class="meta">管理用グループID: ${escapeHtml(g.groupId)}</p>` : ""}
          <p class="items">${escapeHtml(g.items || "").replace(/\n/g, "<br>") || "注文内容なし"}</p>
          <div class="row">
            <span class="subtotal">合計 ${Number(g.groupTotal || 0)}円</span>
            <button
              class="pay-btn"
              data-action="undo-paid"
              data-busy="${pending ? "1" : "0"}"
              data-table="${escapeHtml(g.table)}"
              data-group-id="${escapeHtml(g.groupId)}"
              ${pending ? "disabled" : ""}
            >${pending ? "反映待ち..." : "会計取り消し"}</button>
          </div>
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
    const unconfirmedUrl = `${endpoint}?action=getOrders&status=${encodeURIComponent(
      "未確認"
    )}&date=${encodeURIComponent(date)}&staffToken=${encodeURIComponent(staffToken)}`;
    const confirmedUrl = `${endpoint}?action=getOrders&status=${encodeURIComponent(
      "確認済"
    )}&date=${encodeURIComponent(date)}&staffToken=${encodeURIComponent(staffToken)}`;
    const paidUrl = `${endpoint}?action=getOrders&status=${encodeURIComponent(
      "会計済"
    )}&date=${encodeURIComponent(date)}&staffToken=${encodeURIComponent(staffToken)}`;
    const summaryUrl = `${endpoint}?action=getGroupSummary&date=${encodeURIComponent(
      date
    )}&staffToken=${encodeURIComponent(staffToken)}`;

    const [unconfirmedData, confirmedData, paidData, summary] = await Promise.all([
      jsonpFetch(unconfirmedUrl),
      jsonpFetch(confirmedUrl),
      jsonpFetch(paidUrl),
      jsonpFetch(summaryUrl).catch(() => null)
    ]);
    if (!unconfirmedData || unconfirmedData.result !== "OK") {
      setStatus(`取得失敗: ${(unconfirmedData && unconfirmedData.message) || "unknown error"}`);
      return;
    }
    if (!confirmedData || confirmedData.result !== "OK") {
      setStatus(`取得失敗: ${(confirmedData && confirmedData.message) || "unknown error"}`);
      return;
    }
    if (!paidData || paidData.result !== "OK") {
      setStatus(`取得失敗: ${(paidData && paidData.message) || "unknown error"}`);
      return;
    }

    if (summary && summary.result === "OK") {
      const summaryGroups = summary.groups || [];
      groupLabelMap = buildGroupLabelMapFromGroups(summaryGroups);
      const checkoutWaiting = summaryGroups.filter((g) => String(g && g.status || "") !== "会計済").length;
      updateCheckoutBadge(checkoutWaiting);
    }

    const unconfirmedOrders = unconfirmedData.orders || [];
    const confirmedOrders = confirmedData.orders || [];
    const paidOrders = paidData.orders || [];
    updateUnconfirmedBadge(unconfirmedOrders.length);
    detectAndAlertNewUnconfirmed(unconfirmedOrders, date);
    const processedOrders = confirmedOrders
      .concat(paidOrders)
      .sort((a, b) => (String(a.timestamp || "") < String(b.timestamp || "") ? 1 : -1));
    reconcilePendingOrderActions(unconfirmedOrders, processedOrders);
    renderOrders(unconfirmedOrders);
    renderConfirmedOrders(processedOrders);
    setStatus(
      `注文確認: 未確認 ${Number(unconfirmedData.count || 0)}件 / 処理済み ${Number(
        processedOrders.length
      )}件 (確認済 ${Number(confirmedData.count || 0)} / 会計済 ${Number(paidData.count || 0)}) / ${date}`
    );
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

    const unconfirmedUrl = `${endpoint}?action=getOrders&status=${encodeURIComponent(
      "未確認"
    )}&date=${encodeURIComponent(date)}&staffToken=${encodeURIComponent(staffToken)}`;
    const [activeData, paidData, unconfirmedData] = await Promise.all([
      jsonpFetch(activeUrl),
      jsonpFetch(paidUrl),
      jsonpFetch(unconfirmedUrl).catch(() => null)
    ]);
    if (!activeData || activeData.result !== "OK") {
      setStatus(`取得失敗: ${(activeData && activeData.message) || "unknown error"}`);
      return;
    }
    if (!paidData || paidData.result !== "OK") {
      setStatus(`取得失敗: ${(paidData && paidData.message) || "unknown error"}`);
      return;
    }

    const activeGroups = activeData.groups || [];
    const paidGroups = paidData.groups || [];
    updateCheckoutBadge(Number(activeData.count || activeGroups.length || 0));
    if (unconfirmedData && unconfirmedData.result === "OK") {
      const unconfirmedOrders = unconfirmedData.orders || [];
      updateUnconfirmedBadge(unconfirmedOrders.length);
      detectAndAlertNewUnconfirmed(unconfirmedOrders, date);
    }
    groupLabelMap = buildGroupLabelMapFromGroups(activeGroups.concat(paidGroups));
    reconcilePendingGroupActions(activeGroups, paidGroups);
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

async function markConfirmed(orderId, table, btn) {
  if (!orderId || !table) return;
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
    const sendPromise = fetch(endpoint, {
      method: "POST",
      mode: "no-cors",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString()
    });
    setPendingOrderAction(orderId, table, ["確認済", "会計済"]);
    btn.textContent = "反映待ち...";
    setStatus("確認状態を送信しました。");
    window.setTimeout(loadActiveView, 300);
    sendPromise
      .then(() => waitForOrderStatus(orderId, table, "確認済"))
      .then((ok) => {
        if (!ok) {
          setStatus("確認状態の反映に時間がかかっています。");
          return;
        }
        clearPendingOrderAction(orderId, table);
        setStatus("確認状態を反映しました。");
        loadActiveView();
      })
      .catch(() => {
        clearPendingOrderAction(orderId, table);
        btn.dataset.busy = "0";
        btn.disabled = false;
        btn.textContent = originalText;
        setStatus("確認状態の検証に失敗しました。");
      });
  } catch (error) {
    console.error(error);
    clearPendingOrderAction(orderId, table);
    btn.dataset.busy = "0";
    btn.disabled = false;
    btn.textContent = originalText;
    setStatus("確認状態の更新に失敗しました。");
  }
}

async function waitForOrderStatus(orderId, table, expectedStatus, timeoutMs = verifyTimeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const date = dateInput.value || todayText();
    const url = `${endpoint}?action=checkOrder&date=${encodeURIComponent(
      date
    )}&table=${encodeURIComponent(table)}&orderId=${encodeURIComponent(
      orderId
    )}&token=${encodeURIComponent(staffToken)}`;
    const data = await jsonpFetch(url);
    if (data && data.result === "OK" && data.exists && data.status === expectedStatus) {
      return true;
    }
    await new Promise((r) => window.setTimeout(r, verifyPollIntervalMs));
  }
  return false;
}

async function waitForGroupStatus(table, groupId, expectedStatus, timeoutMs = verifyTimeoutMs) {
  const expectedList = (Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus])
    .map((s) => String(s || "").trim())
    .filter(Boolean);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const date = dateInput.value || todayText();
    const url = `${endpoint}?action=checkGroupStatus&date=${encodeURIComponent(
      date
    )}&table=${encodeURIComponent(table)}&groupId=${encodeURIComponent(
      groupId
    )}&staffToken=${encodeURIComponent(staffToken)}`;
    const data = await jsonpFetch(url);
    if (data && data.result === "OK" && expectedList.indexOf(String(data.status || "").trim()) >= 0) {
      return true;
    }
    await new Promise((r) => window.setTimeout(r, verifyPollIntervalMs));
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
    const sendPromise = fetch(endpoint, {
      method: "POST",
      mode: "no-cors",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString()
    });
    setPendingGroupAction(table, groupId, ["会計済"]);
    btn.textContent = "反映待ち...";
    setStatus("会計状態を送信しました。");
    window.setTimeout(loadGroups, 300);
    sendPromise
      .then(() => waitForGroupStatus(table, groupId, "会計済"))
      .then((ok) => {
        if (!ok) {
          setStatus("会計状態の反映に時間がかかっています。");
          return;
        }
        clearPendingGroupAction(table, groupId);
        setStatus("会計状態を反映しました。");
        loadGroups();
      })
      .catch(() => {
        clearPendingGroupAction(table, groupId);
        btn.dataset.busy = "0";
        btn.disabled = false;
        btn.textContent = originalText;
        setStatus("会計状態の検証に失敗しました。");
      });
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
    const sendPromise = fetch(endpoint, {
      method: "POST",
      mode: "no-cors",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString()
    });
    setPendingGroupAction(table, groupId, ["確認済", "未確認"]);
    btn.textContent = "反映待ち...";
    setStatus("会計取り消しを送信しました。");
    window.setTimeout(loadGroups, 300);
    sendPromise
      .then(() => waitForGroupStatus(table, groupId, ["確認済", "未確認"]))
      .then((ok) => {
        if (!ok) {
          setStatus("会計取り消しの反映に時間がかかっています。");
          return;
        }
        clearPendingGroupAction(table, groupId);
        setStatus("会計取り消しを反映しました。");
        loadGroups();
      })
      .catch(() => {
        clearPendingGroupAction(table, groupId);
        btn.dataset.busy = "0";
        btn.disabled = false;
        btn.textContent = originalText;
        setStatus("会計取り消しの検証に失敗しました。");
      });
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
  markConfirmed(btn.dataset.orderId || "", btn.dataset.table || "", btn);
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
  window.addEventListener("pointerdown", unlockAlertsByUserGesture);
  window.addEventListener("keydown", unlockAlertsByUserGesture);
  switchView("orders");
  window.setInterval(loadActiveView, autoRefreshIntervalMs);
});
