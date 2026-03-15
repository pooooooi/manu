const appConfig = window.APP_CONFIG || {};
const csvUrl =
    appConfig.csvUrl ||
    "https://docs.google.com/spreadsheets/d/1dNk8uLhzl06UJeIsMRYoyLd_MAoHuIpV-qqYIyf8ZS8/export?format=csv&gid=100058082";
const endpoint =
    appConfig.endpoint ||
    "https://script.google.com/macros/s/AKfycbyvdOtISdx0J187OvHt6Jwf7Y8hW_UBEFehLkBJpxmEgn0JvF0jmt6m5TIzDiGknF8k/exec";
const allowedTableSet = new Set(
    (Array.isArray(appConfig.allowedTables) ? appConfig.allowedTables : [])
        .map((v) => String(v || "").trim())
        .filter(Boolean)
);
const startupRetryBatchSize = Math.max(1, Number.parseInt(String(appConfig.startupRetryBatchSize || "3"), 10) || 3);
const resendQueueEnabled = String(appConfig.resendQueueEnabled || "0").trim() === "1";
const jsonpTimeoutMs = Math.max(1500, Number.parseInt(String(appConfig.jsonpTimeoutMs || "5000"), 10) || 5000);
const orderAckTimeoutMs = Math.max(2000, Number.parseInt(String(appConfig.orderAckTimeoutMs || "8000"), 10) || 8000);
const orderAckPollIntervalMs = Math.max(
    150,
    Number.parseInt(String(appConfig.orderAckPollIntervalMs || "350"), 10) || 350
);
const quickOrderAckTimeoutMs = Math.max(
    800,
    Number.parseInt(String(appConfig.quickOrderAckTimeoutMs || "2500"), 10) || 2500
);
const quickOrderAckPollIntervalMs = Math.max(
    120,
    Number.parseInt(String(appConfig.quickOrderAckPollIntervalMs || "250"), 10) || 250
);
const historyStatusSyncConcurrency = Math.max(
    2,
    Number.parseInt(String(appConfig.historyStatusSyncConcurrency || "8"), 10) || 8
);
const historyStatusCacheTtlMs = Math.max(
    10000,
    Number.parseInt(String(appConfig.historyStatusCacheTtlMs || "120000"), 10) || 120000
);
const immediateSubmitMode = String(appConfig.immediateSubmitMode || "1").trim() !== "0";
const skipStorePreflightInImmediateMode =
    String(appConfig.skipStorePreflightInImmediateMode || "1").trim() !== "0";
const skipGroupPreflightInImmediateMode =
    String(appConfig.skipGroupPreflightInImmediateMode || "1").trim() !== "0";
const maxQtyPerItem = Math.max(
    1,
    Number.parseInt(String(appConfig.maxQtyPerItem || "10"), 10) || 10
);
const highQtyConfirmThreshold = Math.max(
    2,
    Number.parseInt(String(appConfig.highQtyConfirmThreshold || "4"), 10) || 4
);

let allMenuItems = [];
let selectedCategory = "";
let isSubmitting = false;
const sendQueueKey = "order-send-queue-v2";
const legacySendQueueKey = "order-send-queue-v1";
const orders = {};
const orderHistory = [];
const urlParams = new URLSearchParams(window.location.search);
const rawTableNumberFromUrl = String(urlParams.get("table") || "").trim();
const tableNumberFromUrl = normalizeTableNumber(rawTableNumberFromUrl);
const rawTableSigFromUrl = String(urlParams.get("sig") || "").trim();
const tableSigFromUrl = normalizeTableSignature(rawTableSigFromUrl);
const historyStatusCache = Object.create(null);
let historySyncPromise = null;

function blockApp(message) {
    document.body.innerHTML = `<h2 style="color:#b91c1c;text-align:center;margin:100px 16px;font-family:sans-serif;">${message}</h2>`;
}

function normalizeTableNumber(raw) {
    const value = String(raw || "").trim();
    if (!value) return "";
    if (!/^[A-Za-z0-9_-]{1,20}$/.test(value)) return "";
    if (allowedTableSet.size > 0 && !allowedTableSet.has(value)) return "";
    return value;
}

function normalizeTableSignature(raw) {
    const value = String(raw || "").trim();
    if (!value) return "";
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(value)) return "";
    return value;
}

function normalizeGroupId(raw) {
    const value = String(raw || "").trim();
    if (!value) return "";
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(value)) return "";
    return value;
}

function readJsonStorage(storage, key, fallbackValue) {
    try {
        const raw = storage.getItem(key);
        if (!raw) return fallbackValue;
        return JSON.parse(raw);
    } catch (_) {
        return fallbackValue;
    }
}

function getSendQueueKey() {
    return `${sendQueueKey}-${tableNumberFromUrl}`;
}

function migrateLegacyQueueIfNeeded() {
    const currentKey = getSendQueueKey();
    const existing = readJsonStorage(localStorage, currentKey, null);
    if (Array.isArray(existing) && existing.length > 0) return;

    const legacy = readJsonStorage(localStorage, legacySendQueueKey, []);
    if (!Array.isArray(legacy) || legacy.length === 0) return;

    const keepLegacy = [];
    const moveToCurrent = [];
    legacy.forEach((item) => {
        if (String(item && item.table || "") === tableNumberFromUrl) {
            moveToCurrent.push(item);
        } else {
            keepLegacy.push(item);
        }
    });
    if (moveToCurrent.length > 0) {
        localStorage.setItem(currentKey, JSON.stringify(moveToCurrent));
    }
    localStorage.setItem(legacySendQueueKey, JSON.stringify(keepLegacy));
}

function purgeSendQueueIfDisabled() {
    if (resendQueueEnabled) return;
    try {
        localStorage.removeItem(getSendQueueKey());
    } catch (_) {}
    try {
        const legacy = readJsonStorage(localStorage, legacySendQueueKey, []);
        if (!Array.isArray(legacy) || legacy.length === 0) {
            localStorage.removeItem(legacySendQueueKey);
            return;
        }
        const keepLegacy = legacy.filter((item) => String(item && item.table || "") !== tableNumberFromUrl);
        if (keepLegacy.length === 0) {
            localStorage.removeItem(legacySendQueueKey);
            return;
        }
        localStorage.setItem(legacySendQueueKey, JSON.stringify(keepLegacy));
    } catch (_) {}
}

function toNumber(value) {
    const n = Number.parseInt(String(value ?? "").trim(), 10);
    return Number.isFinite(n) ? n : 0;
}

function parseTruthyFlag(value) {
    const s = String(value || "").trim().toLowerCase();
    return s === "1" || s === "true" || s === "yes" || s === "on" || s === "売切" || s === "soldout";
}

function isSoldOutItem(item) {
    return parseTruthyFlag(item["売切"]);
}

function showToast(message, type = "info") {
    const container = document.getElementById("toastContainer");
    if (!container) return;
    const toast = document.createElement("div");
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    window.setTimeout(() => {
        toast.style.opacity = "0";
        toast.style.transform = "translateY(-8px)";
        window.setTimeout(() => toast.remove(), 180);
    }, 2200);
}

function normalizeImageUrl(rawUrl) {
    const value = String(rawUrl ?? "").trim();
    if (!value) return "";

    if (value.startsWith("//")) {
        return `${window.location.protocol}${value}`;
    }

    const driveFileMatch = value.match(/https?:\/\/drive\.google\.com\/file\/d\/([^/]+)/i);
    if (driveFileMatch) {
        return `https://drive.google.com/uc?export=view&id=${driveFileMatch[1]}`;
    }

    const driveOpenMatch = value.match(/https?:\/\/drive\.google\.com\/.*[?&]id=([a-zA-Z0-9_-]+)/i);
    if (driveOpenMatch) {
        return `https://drive.google.com/uc?export=view&id=${driveOpenMatch[1]}`;
    }

    if (/^https?:\/\//i.test(value)) {
        return value;
    }

    try {
        return new URL(value, window.location.href).href;
    } catch {
        return "";
    }
}

function getStorageKey() {
    return `orders-${tableNumberFromUrl}`;
}

function getLegacyHistoryKey() {
    return `order-history-${tableNumberFromUrl}`;
}

function getHistoryMigrationFlagKey() {
    return `order-history-migrated-${tableNumberFromUrl}`;
}

function getHistoryKey(groupIdRaw) {
    const groupId = normalizeGroupId(groupIdRaw) || getGroupId();
    return `order-history-${tableNumberFromUrl}-${groupId}`;
}

function parseOrderName(name) {
    const raw = String(name || "").trim();
    const match = raw.match(/^(.*?)(?:・・.*)・・?$/);
    if (!match) return { itemName: raw, options: [] };
    const itemName = (match[1] || "").trim();
    const options = (match[2] || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    return { itemName, options };
}

function normalizeOrderEntry(name, entry) {
    const count = Math.min(maxQtyPerItem, Math.max(0, toNumber(entry.count)));
    const price = Math.max(0, toNumber(entry.price));
    const parsed = parseOrderName(name);
    const itemName = String(entry.itemName || parsed.itemName || "").trim();
    const options = Array.isArray(entry.options)
        ? entry.options.map((s) => String(s).trim()).filter(Boolean)
        : parsed.options;
    return { count, price, itemName, options };
}

function loadSendQueue() {
    if (!resendQueueEnabled) return [];
    const queue = readJsonStorage(localStorage, getSendQueueKey(), []);
    return Array.isArray(queue) ? queue : [];
}

function saveSendQueue(queue) {
    if (!resendQueueEnabled) return;
    localStorage.setItem(getSendQueueKey(), JSON.stringify(queue));
    renderQueueBadge();
}

function enqueueOrder(payload) {
    const queue = loadSendQueue();
    if (queue.some((q) => q && q.orderId === payload.orderId)) return;
    queue.push(payload);
    saveSendQueue(queue);
}

function dequeueOrderById(orderId) {
    const queue = loadSendQueue().filter((q) => q.orderId !== orderId);
    saveSendQueue(queue);
}

function renderQueueBadge() {
    const btn = document.getElementById("retryQueueBtn");
    if (!btn) return;
    if (!resendQueueEnabled) {
        btn.style.display = "none";
        return;
    }
    const count = loadSendQueue().length;
    btn.textContent = `再送キュー ${count}`;
    btn.style.display = count > 0 ? "inline-block" : "none";
}

async function sendOrderPayload(payload) {
    const params = new URLSearchParams();
    params.set("table", String(payload.table || ""));
    params.set("items", String(payload.items || ""));
    params.set("total", String(payload.total || 0));
    params.set("groupId", String(payload.groupId || ""));
    params.set("orderId", String(payload.orderId || ""));
    params.set("orderLines", JSON.stringify(payload.orderLines || []));
    const sig = String(payload.sig || tableSigFromUrl || "").trim();
    if (sig) params.set("sig", sig);
    const legacyToken = String(payload.token || "").trim();
    if (legacyToken) params.set("token", legacyToken);

    // GAS(Web app) ではCORSヘッダー制御が難しいため、
    // simple request + no-cors で送信する。
    await fetch(endpoint, {
        method: "POST",
        mode: "no-cors",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString()
    });
}

async function flushSendQueue(options = {}) {
    const queue = loadSendQueue();
    if (queue.length === 0) return { sent: 0, remaining: 0 };
    const storeStatus = await fetchStoreStatus();
    if (!storeStatus.orderingEnabled) return { sent: 0, remaining: queue.length };

    const maxToSend = Math.max(1, Number.parseInt(String(options.maxToSend || queue.length), 10) || queue.length);
    let sentCount = 0;
    let attempted = 0;
    for (const payload of queue) {
        if (attempted >= maxToSend) break;
        try {
            await sendOrderPayload(payload);
            const accepted = await waitOrderAccepted(payload.orderId, payload.date || currentDateText());
            if (!accepted) {
                throw new Error("order not accepted yet");
            }
            dequeueOrderById(payload.orderId);
            sentCount++;
        } catch {
            // 再送失敗時は残す
        }
        attempted++;
    }
    return { sent: sentCount, remaining: loadSendQueue().length };
}

async function retryPendingOrders() {
    if (!resendQueueEnabled) return;
    const { sent, remaining } = await flushSendQueue({ maxToSend: 50 });
    if (sent > 0 && remaining === 0) {
        showToast("未送信の注文をすべて再送しました。", "success");
        return;
    }
    if (sent > 0) {
        showToast(`一部再送しました。残り ${remaining} 件です。`, "info");
        return;
    }
    showToast("再送できませんでした。通信状況を確認してください。", "error");
}

async function flushSendQueueInBackground() {
    if (!resendQueueEnabled) return;
    try {
        const result = await flushSendQueue({ maxToSend: startupRetryBatchSize });
        if (result.sent > 0) {
            showToast(`未送信注文を ${result.sent} 件再送しました。`, "info");
        }
    } catch (_) {
        // 起動時再送は非同期で静かに失敗させる
    }
}

async function fetchStoreStatus() {
    try {
        const data = await jsonpFetch(`${endpoint}?action=getStoreStatus`);
        return {
            orderingEnabled: !!(data && data.result === "OK" && data.orderingEnabled)
        };
    } catch (_) {
        // fail-closed: ステータス確認不能時は注文停止扱い
        return { orderingEnabled: false };
    }
}

async function ensureStoreOpenForOrder() {
    const status = await fetchStoreStatus();
    if (!status.orderingEnabled) {
        throw new Error("store closed");
    }
}

function parseCSV(text) {
    const rows = [];
    let row = [];
    let cell = "";
    let inQuotes = false;
    const normalized = text.replace(/\r\n/g, "\n");

    for (let i = 0; i < normalized.length; i++) {
        const ch = normalized[i];
        const next = normalized[i + 1];

        if (ch === '"') {
            if (inQuotes && next === '"') {
                cell += '"';
                i++;
            } else {
                inQuotes = !inQuotes;
            }
            continue;
        }

        if (ch === "," && !inQuotes) {
            row.push(cell);
            cell = "";
            continue;
        }

        if (ch === "\n" && !inQuotes) {
            row.push(cell);
            rows.push(row);
            row = [];
            cell = "";
            continue;
        }

        cell += ch;
    }

    if (cell.length > 0 || row.length > 0) {
        row.push(cell);
        rows.push(row);
    }
    return rows;
}

function jsonpFetch(url) {
    return new Promise((resolve, reject) => {
        const callbackName = `menuCb${Date.now()}${Math.floor(Math.random() * 10000)}`;
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

function currentDateText() {
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "Asia/Tokyo",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
    }).formatToParts(new Date());
    const y = (parts.find((p) => p.type === "year") || {}).value || "";
    const m = (parts.find((p) => p.type === "month") || {}).value || "";
    const day = (parts.find((p) => p.type === "day") || {}).value || "";
    return `${y}-${m}-${day}`;
}

async function loadCSV() {
    const res = await fetch(csvUrl);
    if (!res.ok) {
        throw new Error(`CSV取得に失敗: ${res.status}`);
    }
    const text = await res.text();
    const rows = parseCSV(text).filter((r) => r.some((c) => String(c).trim() !== ""));
    if (rows.length < 2) {
        return [];
    }

    const headers = rows[0].map((h) => String(h).trim());
    return rows.slice(1).map((r) => {
        const obj = {};
        headers.forEach((h, i) => {
            obj[h] = (r[i] ?? "").trim();
        });
        return obj;
    });
}

function loadOrdersFromStorage() {
    const storedOrders = readJsonStorage(sessionStorage, getStorageKey(), {});
    Object.keys(orders).forEach((key) => delete orders[key]);
    if (!storedOrders || typeof storedOrders !== "object" || Array.isArray(storedOrders)) return;
    Object.entries(storedOrders).forEach(([name, entry]) => {
        const normalized = normalizeOrderEntry(name, entry || {});
        if (normalized.count <= 0) return;
        orders[name] = normalized;
    });
}

function saveOrdersToStorage() {
    sessionStorage.setItem(getStorageKey(), JSON.stringify(orders));
}

function loadHistoryFromStorage() {
    const currentGroupId = getGroupId();
    const storedHistory = readJsonStorage(sessionStorage, getHistoryKey(currentGroupId), []);
    let source = storedHistory;

    const migrated = sessionStorage.getItem(getHistoryMigrationFlagKey()) === "1";
    if ((!Array.isArray(source) || source.length === 0) && currentGroupId && !migrated) {
        const legacy = readJsonStorage(sessionStorage, getLegacyHistoryKey(), []);
        if (Array.isArray(legacy) && legacy.length > 0) {
            source = legacy
                .filter((entry) => {
                    const gid = normalizeGroupId(entry && entry.groupId);
                    if (!gid) return true;
                    return gid === currentGroupId;
                })
                .map((entry) => ({
                    ...(entry || {}),
                    groupId: normalizeGroupId(entry && entry.groupId) || currentGroupId
                }));
            if (source.length > 0) {
                sessionStorage.setItem(getHistoryKey(currentGroupId), JSON.stringify(source));
            }
            sessionStorage.setItem(getHistoryMigrationFlagKey(), "1");
        }
    }

    orderHistory.length = 0;
    if (Array.isArray(source)) {
        orderHistory.push(...source);
    }
}

function saveHistoryToStorage() {
    const currentGroupId = getGroupId();
    const normalized = orderHistory.map((entry) => ({
        ...(entry || {}),
        groupId: normalizeGroupId(entry && entry.groupId) || currentGroupId
    }));
    sessionStorage.setItem(getHistoryKey(currentGroupId), JSON.stringify(normalized));
}

function renderCategories(items) {
    const categories = [...new Set(items.map((item) => item["カテゴリ"]).filter(Boolean))];
    const btnContainer = document.getElementById("categoryButtons");
    btnContainer.innerHTML = "";

    categories.forEach((cat) => {
        const btn = document.createElement("button");
        btn.textContent = cat;
        btn.classList.add("category-btn");
        btn.onclick = () => {
            selectedCategory = cat;
            renderMenuItems();
            document
                .querySelectorAll(".category-buttons button")
                .forEach((b) => b.classList.remove("selected"));
            btn.classList.add("selected");
        };

        if (cat === selectedCategory) {
            btn.classList.add("selected");
        }
        btnContainer.appendChild(btn);
    });
}

function renderMenuItems() {
    const container = document.getElementById("menuContainer");
    container.innerHTML = "";

    const items = selectedCategory
        ? allMenuItems.filter((item) => item["カテゴリ"] === selectedCategory)
        : allMenuItems;

    items.forEach((item) => {
        const div = document.createElement("div");
        div.className = "menuItem";
        const soldOut = isSoldOutItem(item);

        const img = document.createElement("img");
        img.alt = item["商品名"] || "";
        img.loading = "lazy";
        img.referrerPolicy = "no-referrer";
        const imageUrl = normalizeImageUrl(item["画像URL"]);
        if (imageUrl) {
            img.src = imageUrl;
        } else {
            img.classList.add("is-empty");
        }
        img.onerror = () => img.classList.add("is-empty");

        const text = document.createElement("div");
        text.className = "menu-text";
        const h4 = document.createElement("h4");
        h4.textContent = item["商品名"] || "Item";
        const p = document.createElement("p");
        p.textContent = soldOut ? "売切れ" : `${toNumber(item["金額"])} 円`;
        text.appendChild(h4);
        text.appendChild(p);

        div.appendChild(img);
        div.appendChild(text);
        if (soldOut) {
            div.style.opacity = "0.45";
            div.style.cursor = "not-allowed";
        } else {
            div.onclick = () => showOptions(item);
        }
        container.appendChild(div);
    });
}

function renderOrder() {
    loadOrdersFromStorage();
    const list = document.getElementById("orderItems");
    list.innerHTML = "";
    let total = 0;
    let itemCount = 0;

    const entries = Object.entries(orders);
    if (entries.length === 0) {
        const empty = document.createElement("li");
        empty.className = "order-empty";
        empty.textContent = "注文リストは空です。";
        list.appendChild(empty);
    }

    entries.forEach(([name, order]) => {
        const count = toNumber(order.count);
        const price = toNumber(order.price);
        const lineTotal = price * count;
        const li = document.createElement("li");
        li.className = "order-line-item";

        const main = document.createElement("div");
        main.className = "order-line-main";
        const nameEl = document.createElement("span");
        nameEl.className = "order-line-name";
        nameEl.textContent = String(name || "");
        const metaEl = document.createElement("span");
        metaEl.className = "order-line-meta";
        metaEl.textContent = `${count}点 / ${lineTotal}円`;
        main.appendChild(nameEl);
        main.appendChild(metaEl);
        li.appendChild(main);

        const controls = document.createElement("div");
        controls.className = "order-line-controls";

        const minusBtn = document.createElement("button");
        minusBtn.type = "button";
        minusBtn.textContent = "−";
        minusBtn.className = "order-line-minus";
        minusBtn.addEventListener("click", () => decreaseItem(name));
        controls.appendChild(minusBtn);

        const qtyEl = document.createElement("span");
        qtyEl.className = "order-line-qty";
        qtyEl.textContent = String(count);
        controls.appendChild(qtyEl);

        const plusBtn = document.createElement("button");
        plusBtn.type = "button";
        plusBtn.textContent = "+";
        plusBtn.className = "order-line-plus";
        plusBtn.disabled = count >= maxQtyPerItem;
        plusBtn.addEventListener("click", () => increaseItem(name));
        controls.appendChild(plusBtn);

        li.appendChild(controls);

        total += lineTotal;
        itemCount += count;
        list.appendChild(li);
    });

    document.getElementById("totalPrice").textContent = String(total);
    const badge = document.getElementById("orderBadge");
    badge.textContent = String(itemCount);
    badge.style.display = "inline-block";
}

function formatHistoryDateLabel_(entry) {
    const createdAt = String(entry && entry.createdAt || "").trim();
    if (createdAt) {
        const d = new Date(createdAt);
        if (!Number.isNaN(d.getTime())) {
            return new Intl.DateTimeFormat("ja-JP", {
                timeZone: "Asia/Tokyo",
                month: "2-digit",
                day: "2-digit",
                hour: "2-digit",
                minute: "2-digit"
            }).format(d);
        }
    }
    return String(entry && entry.date || "").trim();
}

function formatHistoryOrderIdLabel_(orderId) {
    const id = String(orderId || "").trim();
    if (!id) return "";
    return `注文ID: ${id.slice(-8)}`;
}

function buildHistoryMenuPriceMap_() {
    const map = Object.create(null);
    for (let i = 0; i < allMenuItems.length; i++) {
        const item = allMenuItems[i] || {};
        const name = String(item["商品名"] || "").trim();
        if (!name) continue;
        const options = Object.create(null);
        for (let j = 1; j <= 10; j++) {
            const optName = String(item[`オプション${j}`] || "").trim();
            if (!optName) continue;
            options[optName] = toNumber(item[`オプション${j}金額`]);
        }
        map[name] = {
            basePrice: toNumber(item["金額"]),
            options
        };
    }
    return map;
}

function splitHistoryItemsText_(text) {
    const input = String(text || "").trim();
    if (!input) return [];
    const chunks = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < input.length; i++) {
        const ch = input[i];
        if (ch === "（") depth++;
        if (ch === "）" && depth > 0) depth--;
        if (ch === "," && depth === 0) {
            const part = input.slice(start, i).trim();
            if (part) chunks.push(part);
            start = i + 1;
        }
    }
    const tail = input.slice(start).trim();
    if (tail) chunks.push(tail);
    return chunks;
}

function parseHistoryLineName_(name) {
    const text = String(name || "").trim();
    if (!text) return { itemName: "", options: [] };
    const m = text.match(/^(.*?)（(.*)）$/);
    if (!m) return { itemName: text, options: [] };
    const itemName = String(m[1] || "").trim();
    const options = String(m[2] || "")
        .split(",")
        .map((v) => String(v || "").trim())
        .filter(Boolean);
    return { itemName, options };
}

function normalizeHistoryLinesFromEntry_(entry) {
    const lines = [];
    const rawLines = Array.isArray(entry && entry.lines) ? entry.lines : [];
    for (let i = 0; i < rawLines.length; i++) {
        const row = rawLines[i] || {};
        const name = String(row.name || "").trim();
        const quantity = Math.max(0, toNumber(row.quantity));
        if (!name || quantity <= 0) continue;
        lines.push({
            name,
            quantity,
            lineTotal: Math.max(0, toNumber(row.lineTotal)),
            unitPrice: Math.max(0, toNumber(row.unitPrice))
        });
    }
    if (lines.length > 0) return lines;

    const fallbackItems = splitHistoryItemsText_(entry && entry.items);
    for (let i = 0; i < fallbackItems.length; i++) {
        const token = String(fallbackItems[i] || "").trim();
        if (!token) continue;
        const m = token.match(/^(.*?)\s*x\s*(\d+)$/i);
        const name = String((m && m[1]) || token).trim();
        const quantity = Math.max(1, toNumber((m && m[2]) || "1"));
        lines.push({ name, quantity, lineTotal: 0, unitPrice: 0 });
    }
    return lines;
}

function resolveHistoryLineAmount_(line, menuPriceMap) {
    const quantity = Math.max(0, toNumber(line && line.quantity));
    if (quantity <= 0) return 0;

    const explicitLineTotal = Math.max(0, toNumber(line && line.lineTotal));
    if (explicitLineTotal > 0) return explicitLineTotal;

    const explicitUnitPrice = Math.max(0, toNumber(line && line.unitPrice));
    if (explicitUnitPrice > 0) return explicitUnitPrice * quantity;

    const parsed = parseHistoryLineName_(line && line.name);
    const menu = menuPriceMap[String(parsed.itemName || "").trim()];
    if (!menu) return 0;

    let unit = Math.max(0, toNumber(menu.basePrice));
    const options = Array.isArray(parsed.options) ? parsed.options : [];
    for (let i = 0; i < options.length; i++) {
        const optName = String(options[i] || "").trim();
        if (!optName) continue;
        unit += Math.max(0, toNumber(menu.options && menu.options[optName]));
    }
    return unit * quantity;
}

function buildHistoryRowsForDisplay_(historyEntries, menuPriceMap) {
    const aggregate = new Map();
    let grandTotal = 0;

    for (let i = historyEntries.length - 1; i >= 0; i--) {
        const entry = historyEntries[i] || {};
        const baseRows = normalizeHistoryLinesFromEntry_(entry);
        if (baseRows.length === 0) continue;

        const resolvedRows = baseRows.map((row) => ({
            name: String(row.name || "").trim(),
            quantity: Math.max(0, toNumber(row.quantity)),
            amount: resolveHistoryLineAmount_(row, menuPriceMap)
        }));

        let knownSum = 0;
        const unknownIndexes = [];
        for (let j = 0; j < resolvedRows.length; j++) {
            if (resolvedRows[j].amount > 0) {
                knownSum += resolvedRows[j].amount;
            } else {
                unknownIndexes.push(j);
            }
        }

        const entryTotal = Math.max(0, toNumber(entry.total));
        if (unknownIndexes.length > 0 && entryTotal > 0) {
            let remain = Math.max(0, entryTotal - knownSum);
            const count = unknownIndexes.length;
            const baseShare = count > 0 ? Math.floor(remain / count) : 0;
            for (let j = 0; j < unknownIndexes.length; j++) {
                const idx = unknownIndexes[j];
                let share = baseShare;
                if (remain > 0) {
                    const extra = Math.min(remain - baseShare * (count - j), 1);
                    if (extra > 0) share += extra;
                }
                resolvedRows[idx].amount = Math.max(0, share);
                remain -= share;
            }
        }

        const computedEntryTotal = resolvedRows.reduce((sum, row) => sum + Math.max(0, toNumber(row.amount)), 0);
        grandTotal += entryTotal > 0 ? entryTotal : computedEntryTotal;

        for (let j = 0; j < resolvedRows.length; j++) {
            const row = resolvedRows[j];
            if (!row.name || row.quantity <= 0) continue;
            if (!aggregate.has(row.name)) {
                aggregate.set(row.name, { name: row.name, quantity: 0, amount: 0 });
            }
            const current = aggregate.get(row.name);
            current.quantity += row.quantity;
            current.amount += Math.max(0, toNumber(row.amount));
        }
    }

    return {
        rows: Array.from(aggregate.values()),
        total: grandTotal
    };
}

function renderHistory() {
    const historyList = document.getElementById("historyItems");
    historyList.innerHTML = "";

    const menuPriceMap = buildHistoryMenuPriceMap_();
    const display = buildHistoryRowsForDisplay_(orderHistory, menuPriceMap);
    const rows = display.rows;

    if (rows.length === 0) {
        const empty = document.createElement("li");
        empty.className = "history-empty";
        empty.textContent = "注文履歴はまだありません。";
        historyList.appendChild(empty);
        document.getElementById("historyTotal").textContent = "0";
        return;
    }

    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const li = document.createElement("li");
        li.className = "history-line-item";

        const nameEl = document.createElement("span");
        nameEl.className = "history-line-name";
        nameEl.textContent = `${row.name} x ${Math.max(1, toNumber(row.quantity))}`;

        const amountEl = document.createElement("strong");
        amountEl.className = "history-line-total";
        amountEl.textContent = `${Math.max(0, toNumber(row.amount))} 円`;

        li.appendChild(nameEl);
        li.appendChild(amountEl);
        historyList.appendChild(li);
    }

    document.getElementById("historyTotal").textContent = String(Math.max(0, toNumber(display.total)));
}

function clearHistory() {
    if (!confirm("本当に履歴をクリアしますか？")) return;
    sessionStorage.removeItem(getHistoryKey(getGroupId()));
    orderHistory.length = 0;
    renderHistory();
    showToast("注文履歴をクリアしました。", "success");
}

function decreaseItem(name) {
    if (!orders[name]) return;
    orders[name].count = toNumber(orders[name].count) - 1;
    if (orders[name].count <= 0) {
        delete orders[name];
    }
    saveOrdersToStorage();
    renderOrder();
}

function increaseItem(name) {
    if (!orders[name]) return;
    const next = toNumber(orders[name].count) + 1;
    if (next > maxQtyPerItem) {
        showToast(`1商品あたり最大 ${maxQtyPerItem} 点までです。`, "error");
        return;
    }
    orders[name].count = next;
    saveOrdersToStorage();
    renderOrder();
}

function toggleOrderModal() {
    const modal = document.getElementById("orderModal");
    modal.style.display = modal.style.display === "block" ? "none" : "block";
}

async function toggleHistoryModal() {
    const modal = document.getElementById("historyModal");
    if (modal.style.display === "block") {
        modal.style.display = "none";
        setHistorySyncStatus_("");
        return;
    }
    loadHistoryFromStorage();
    renderHistory();
    modal.style.display = "block";
    void syncHistoryAfterOpen_();
}

let selectedItem = null;

function ensureOptionSelectionSummaryEl_() {
    const optionList = document.getElementById("optionList");
    if (!optionList) return null;
    let el = document.getElementById("optionSelectionSummary");
    if (el) return el;
    el = document.createElement("p");
    el.id = "optionSelectionSummary";
    el.className = "option-selection-summary";
    optionList.insertAdjacentElement("afterend", el);
    return el;
}

function updateOptionSelectionSummary_() {
    const summaryEl = ensureOptionSelectionSummaryEl_();
    if (!summaryEl) return;
    const basePrice = toNumber(selectedItem && selectedItem["金額"]);
    const checkboxes = document.querySelectorAll('#optionList input[type="checkbox"]');
    let selectedCount = 0;
    let extra = 0;
    checkboxes.forEach((cb) => {
        const card = cb.closest(".option-item");
        if (card) {
            card.classList.toggle("is-selected", !!cb.checked);
        }
        if (!cb.checked) return;
        selectedCount += 1;
        extra += toNumber(cb.dataset.optionPrice);
    });

    const total = basePrice + extra;
    if (checkboxes.length === 0) {
        summaryEl.textContent = `合計 ${total}円`;
        return;
    }
    if (selectedCount === 0) {
        summaryEl.textContent = `オプション未選択 / 合計 ${total}円`;
        return;
    }
    summaryEl.textContent = `選択 ${selectedCount}件 (+${extra}円) / 合計 ${total}円`;
}

function showOptions(item) {
    selectedItem = item;
    document.getElementById("optionTitle").textContent = `${item["商品名"] || ""} ${toNumber(item["金額"])}円`;
    const optionList = document.getElementById("optionList");
    const addOptionsBtn = document.getElementById("addOptionsBtn");
    const addWithoutOptionsBtn = document.getElementById("addWithoutOptionsBtn");
    const optionImageWrap = document.getElementById("optionImageWrap");
    const optionImage = document.getElementById("optionImage");
    optionList.innerHTML = "";

    const imageUrl = normalizeImageUrl(item["画像URL"]);
    if (optionImageWrap && optionImage) {
        if (imageUrl) {
            optionImage.src = imageUrl;
            optionImage.alt = item["商品名"] || "";
            optionImageWrap.classList.add("is-visible");
            optionImage.onerror = () => {
                optionImageWrap.classList.remove("is-visible");
                optionImage.removeAttribute("src");
            };
        } else {
            optionImageWrap.classList.remove("is-visible");
            optionImage.removeAttribute("src");
            optionImage.alt = "";
        }
    }

    let i = 1;
    let optionCount = 0;
    while (item[`オプション${i}`]) {
        const name = item[`オプション${i}`];
        const price = toNumber(item[`オプション${i}金額`]);

        const label = document.createElement("label");
        label.className = "option-item";
        const input = document.createElement("input");
        input.type = "checkbox";
        input.value = `opt-${i}`;
        input.dataset.optionName = String(name || "");
        input.dataset.optionPrice = String(price);
        input.addEventListener("change", updateOptionSelectionSummary_);

        const textWrap = document.createElement("span");
        textWrap.className = "option-item-text";
        const nameEl = document.createElement("span");
        nameEl.className = "option-item-name";
        nameEl.textContent = String(name || "");
        const priceEl = document.createElement("span");
        priceEl.className = "option-item-price";
        priceEl.textContent = `+${price}円`;
        label.appendChild(input);
        textWrap.appendChild(nameEl);
        textWrap.appendChild(priceEl);
        label.appendChild(textWrap);

        optionList.appendChild(label);
        optionCount++;
        i++;
    }

    if (addOptionsBtn) {
        addOptionsBtn.textContent = "選択して追加";
        addOptionsBtn.style.display = optionCount > 0 ? "inline-block" : "none";
    }
    if (addWithoutOptionsBtn) {
        addWithoutOptionsBtn.style.display = "inline-block";
        if (optionCount > 0) {
            addWithoutOptionsBtn.textContent = "オプションなしで追加";
            addWithoutOptionsBtn.classList.remove("option-action-primary");
            addWithoutOptionsBtn.classList.add("option-action-secondary");
        } else {
            addWithoutOptionsBtn.textContent = "注文リストに追加";
            addWithoutOptionsBtn.classList.remove("option-action-secondary");
            addWithoutOptionsBtn.classList.add("option-action-primary");
        }
    }
    if (optionCount === 0) {
        optionList.textContent = "この商品はオプションを選べません。";
    }
    updateOptionSelectionSummary_();

    document.getElementById("optionModal").style.display = "flex";
}

function closeModal() {
    const addOptionsBtn = document.getElementById("addOptionsBtn");
    const addWithoutOptionsBtn = document.getElementById("addWithoutOptionsBtn");
    const optionImageWrap = document.getElementById("optionImageWrap");
    const optionImage = document.getElementById("optionImage");
    if (addOptionsBtn) addOptionsBtn.style.display = "inline-block";
    if (addWithoutOptionsBtn) {
        addWithoutOptionsBtn.style.display = "inline-block";
        addWithoutOptionsBtn.textContent = "注文リストに追加";
        addWithoutOptionsBtn.classList.remove("option-action-primary");
        addWithoutOptionsBtn.classList.add("option-action-secondary");
    }
    if (optionImageWrap) optionImageWrap.classList.remove("is-visible");
    if (optionImage) {
        optionImage.removeAttribute("src");
        optionImage.alt = "";
    }
    const summaryEl = document.getElementById("optionSelectionSummary");
    if (summaryEl) summaryEl.textContent = "";
    selectedItem = null;
    document.getElementById("optionModal").style.display = "none";
}

function addOptionsToOrder() {
    if (!selectedItem) return;
    const baseName = selectedItem["商品名"] || "Item";
    const basePrice = toNumber(selectedItem["金額"]);
    const checkboxes = document.querySelectorAll('#optionList input[type="checkbox"]');
    const selectedNames = [];
    let extraPrice = 0;

    checkboxes.forEach((cb) => {
        if (cb.checked) {
            const name = String(cb.dataset.optionName || "").trim();
            const price = cb.dataset.optionPrice;
            if (!name) return;
            selectedNames.push(name);
            extraPrice += toNumber(price);
        }
    });

    if (selectedNames.length === 0) {
        showToast("オプションを1つ以上選択してください。", "error");
        return;
    }

    const fullName = `${baseName}（${selectedNames.join(", ")}）`;
    if (!orders[fullName]) {
        orders[fullName] = {
            count: 1,
            price: basePrice + extraPrice,
            itemName: baseName,
            options: [...selectedNames]
        };
    } else {
        const next = toNumber(orders[fullName].count) + 1;
        if (next > maxQtyPerItem) {
            showToast(`1商品あたり最大 ${maxQtyPerItem} 点までです。`, "error");
            return;
        }
        orders[fullName].count = next;
    }

    saveOrdersToStorage();
    renderOrder();
    closeModal();
    showToast("注文リストに追加しました。", "success");
}

function addItemWithoutOptions() {
    if (!selectedItem) return;
    const baseName = selectedItem["商品名"] || "Item";
    const basePrice = toNumber(selectedItem["金額"]);

    if (!orders[baseName]) {
        orders[baseName] = {
            count: 1,
            price: basePrice,
            itemName: baseName,
            options: []
        };
    } else {
        const next = toNumber(orders[baseName].count) + 1;
        if (next > maxQtyPerItem) {
            showToast(`1商品あたり最大 ${maxQtyPerItem} 点までです。`, "error");
            return;
        }
        orders[baseName].count = next;
    }

    saveOrdersToStorage();
    renderOrder();
    closeModal();
    showToast("注文リストに追加しました。", "success");
}

function getGroupId() {
    const groupId = normalizeGroupId(sessionStorage.getItem("groupId"));
    if (groupId) return groupId;
    return ensureGroupId();
}

function createGroupId() {
    return `grp-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
}

function ensureGroupId() {
    const params = new URLSearchParams(window.location.search);
    let groupId = normalizeGroupId(params.get("group"));
    if (!groupId) {
        groupId = createGroupId();
        params.set("group", groupId);
        const newUrl = `${window.location.pathname}?${params.toString()}`;
        window.history.replaceState({}, "", newUrl);
    }
    sessionStorage.setItem("groupId", groupId);
    return groupId;
}

function rotateGroupId() {
    const newGroupId = createGroupId();
    const params = new URLSearchParams(window.location.search);
    params.set("group", newGroupId);
    const newUrl = `${window.location.pathname}?${params.toString()}`;
    window.history.replaceState({}, "", newUrl);
    sessionStorage.setItem("groupId", newGroupId);
    return newGroupId;
}

async function ensureCurrentGroupIsActive(tableNumber) {
    const current = getGroupId();
    const url = `${endpoint}?action=checkGroupStatus&date=${encodeURIComponent(
        currentDateText()
    )}&table=${encodeURIComponent(tableNumber)}&groupId=${encodeURIComponent(
        current
    )}&sig=${encodeURIComponent(tableSigFromUrl)}`;
    try {
        const data = await jsonpFetch(url);
        if (data && data.result === "OK" && data.status === "会計済") {
            return rotateGroupId();
        }
    } catch (_) {
        // 確認失敗時は現行groupを維持
    }
    return current;
}

async function fetchOrderStatusForHistory(orderId, dateText, tableNumber) {
    const date = String(dateText || "").trim();
    const table = String(tableNumber || "").trim() || tableNumberFromUrl;
    const id = String(orderId || "").trim();
    if (!date || !table || !id) return null;

    const url = `${endpoint}?action=checkOrder&date=${encodeURIComponent(
        date
    )}&table=${encodeURIComponent(table)}&orderId=${encodeURIComponent(
        id
    )}&sig=${encodeURIComponent(tableSigFromUrl)}`;
    const data = await jsonpFetch(url);
    if (!data || data.result !== "OK" || !data.exists) return null;
    return String(data.status || "").trim();
}

function makeHistoryStatusKey_(dateText, orderId) {
    if (
        typeof window !== "undefined" &&
        window.ManuSharedLogic &&
        typeof window.ManuSharedLogic.makeHistoryStatusKey === "function"
    ) {
        return window.ManuSharedLogic.makeHistoryStatusKey(dateText, orderId);
    }
    return `${String(dateText || "").trim()}::${String(orderId || "").trim()}`;
}

function getHistoryStatusFromCache_(dateText, orderId) {
    const key = makeHistoryStatusKey_(dateText, orderId);
    const cache = historyStatusCache[key];
    if (!cache) return "";
    if ((Number(cache.expiresAt) || 0) <= Date.now()) {
        delete historyStatusCache[key];
        return "";
    }
    return String(cache.status || "").trim();
}

function setHistoryStatusCache_(dateText, orderId, status) {
    const normalizedStatus = String(status || "").trim();
    if (!normalizedStatus) return;
    historyStatusCache[makeHistoryStatusKey_(dateText, orderId)] = {
        status: normalizedStatus,
        expiresAt: Date.now() + historyStatusCacheTtlMs
    };
}

async function runWithConcurrency_(tasks, maxConcurrency, worker) {
    const list = Array.isArray(tasks) ? tasks : [];
    if (list.length === 0) return;
    const concurrency = Math.max(1, toNumber(maxConcurrency));
    let cursor = 0;
    const workers = [];
    const runnerCount = Math.min(concurrency, list.length);
    for (let i = 0; i < runnerCount; i++) {
        workers.push((async () => {
            while (true) {
                const idx = cursor;
                cursor += 1;
                if (idx >= list.length) break;
                await worker(list[idx], idx);
            }
        })());
    }
    await Promise.all(workers);
}

function ensureHistorySyncStatusElement_() {
    const modal = document.getElementById("historyModal");
    if (!modal) return null;
    let status = document.getElementById("historySyncStatus");
    if (status) return status;

    status = document.createElement("p");
    status.id = "historySyncStatus";
    status.className = "history-sync-status";
    const historyList = document.getElementById("historyItems");
    if (historyList && historyList.parentNode === modal) {
        modal.insertBefore(status, historyList);
    } else {
        modal.appendChild(status);
    }
    return status;
}

function setHistorySyncStatus_(message, type = "info") {
    const status = ensureHistorySyncStatusElement_();
    if (!status) return;
    const text = String(message || "").trim();
    if (!text) {
        status.textContent = "";
        status.className = "history-sync-status";
        status.style.display = "none";
        return;
    }
    status.textContent = text;
    status.className = `history-sync-status ${type}`;
    status.style.display = "block";
}

function syncHistoryAfterOpen_() {
    if (historySyncPromise) return historySyncPromise;
    setHistorySyncStatus_("履歴を同期中...", "info");
    historySyncPromise = removeCanceledHistoryEntries()
        .then((result) => {
            if (result.changed) {
                renderHistory();
            }
            if (result.removed > 0) {
                setHistorySyncStatus_(`取消済み ${result.removed} 件を履歴から除外しました。`, "success");
            } else {
                setHistorySyncStatus_("履歴は最新です。", "info");
            }
        })
        .catch(() => {
            setHistorySyncStatus_("履歴同期に失敗しました。", "error");
        })
        .finally(() => {
            historySyncPromise = null;
            window.setTimeout(() => setHistorySyncStatus_(""), 1500);
        });
    return historySyncPromise;
}

function filterOutCanceledHistoryEntries_(entries, statusByKey) {
    if (
        typeof window !== "undefined" &&
        window.ManuSharedLogic &&
        typeof window.ManuSharedLogic.filterOutCanceledHistoryEntries === "function"
    ) {
        return window.ManuSharedLogic.filterOutCanceledHistoryEntries(entries, statusByKey);
    }

    const list = Array.isArray(entries) ? entries : [];
    const map = statusByKey && typeof statusByKey === "object" ? statusByKey : {};
    const out = [];
    for (let i = 0; i < list.length; i++) {
        const entry = list[i] || {};
        const orderId = String(entry.orderId || "").trim();
        const date = String(entry.date || "").trim();
        if (!orderId || !date) {
            out.push(entry);
            continue;
        }
        const key = makeHistoryStatusKey_(date, orderId);
        if (String(map[key] || "").trim() === "取消済") continue;
        out.push(entry);
    }
    return out;
}

async function removeCanceledHistoryEntries() {
    loadHistoryFromStorage();
    if (orderHistory.length === 0) {
        return { changed: false, removed: 0, checked: 0, fromCache: 0, errors: 0 };
    }

    const statusByKey = {};
    const targets = [];
    let fromCache = 0;
    for (let i = 0; i < orderHistory.length; i++) {
        const entry = orderHistory[i] || {};
        const orderId = String(entry.orderId || "").trim();
        const dateText = String(entry.date || "").trim();
        if (!orderId || !dateText) continue;
        const key = makeHistoryStatusKey_(dateText, orderId);
        if (Object.prototype.hasOwnProperty.call(statusByKey, key)) continue;

        const cached = getHistoryStatusFromCache_(dateText, orderId);
        if (cached) {
            statusByKey[key] = cached;
            fromCache += 1;
            continue;
        }
        targets.push({
            key,
            orderId,
            dateText,
            table: String(entry.table || "").trim()
        });
    }

    let errors = 0;
    await runWithConcurrency_(targets, historyStatusSyncConcurrency, async (target) => {
        try {
            const status = await fetchOrderStatusForHistory(target.orderId, target.dateText, target.table);
            if (!status) return;
            statusByKey[target.key] = status;
            setHistoryStatusCache_(target.dateText, target.orderId, status);
        } catch (_) {
            errors += 1;
        }
    });

    const next = filterOutCanceledHistoryEntries_(orderHistory, statusByKey);
    const removed = Math.max(0, orderHistory.length - next.length);
    if (removed === 0) {
        return {
            changed: false,
            removed: 0,
            checked: targets.length,
            fromCache: fromCache,
            errors: errors
        };
    }
    orderHistory.length = 0;
    orderHistory.push(...next);
    saveHistoryToStorage();
    return {
        changed: true,
        removed: removed,
        checked: targets.length,
        fromCache: fromCache,
        errors: errors
    };
}

async function waitOrderAccepted(orderId, dateText, options = {}) {
    const timeoutMs = Math.max(
        500,
        Number.parseInt(String(options.timeoutMs || orderAckTimeoutMs), 10) || orderAckTimeoutMs
    );
    const pollIntervalMs = Math.max(
        120,
        Number.parseInt(String(options.pollIntervalMs || orderAckPollIntervalMs), 10) || orderAckPollIntervalMs
    );
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        const url = `${endpoint}?action=checkOrder&date=${encodeURIComponent(
            dateText
        )}&table=${encodeURIComponent(tableNumberFromUrl)}&orderId=${encodeURIComponent(
            orderId
        )}&sig=${encodeURIComponent(tableSigFromUrl)}`;
        try {
            const data = await jsonpFetch(url);
            if (data && data.result === "OK" && data.exists) return true;
            if (data && data.result === "error" && String(data.message || "") === "unauthorized") {
                return false;
            }
        } catch (_) {
            // 一時的な通信/JSONP失敗では即失敗せず、タイムアウトまで再試行する。
        }
        await new Promise((r) => window.setTimeout(r, pollIntervalMs));
    }
    return false;
}

async function verifyOrderAcceptedInBackground(payload) {
    try {
        const accepted = await waitOrderAccepted(payload.orderId, payload.date, {
            timeoutMs: orderAckTimeoutMs,
            pollIntervalMs: orderAckPollIntervalMs
        });
        if (accepted) {
            if (resendQueueEnabled) {
                dequeueOrderById(payload.orderId);
            }
            return;
        }
    } catch (_) {
        // ignore; fallback to queue flush
    }
    if (resendQueueEnabled) {
        await flushSendQueueInBackground();
        return;
    }
    showToast("注文送信の確認ができませんでした。注文履歴を確認してください。", "error");
}

async function submitOrder() {
    if (isSubmitting) return;
    const confirmBtn = document.getElementById("confirmOrderBtn");
    const originalLabel = confirmBtn ? confirmBtn.textContent : "";
    const useImmediateMode = immediateSubmitMode;
    isSubmitting = true;
    try {
        if (confirmBtn) {
            confirmBtn.disabled = true;
            confirmBtn.textContent = "確認中...";
        }

        if (!navigator.onLine) {
            showToast("オフラインのため送信できません。通信を確認してください。", "error");
            return;
        }
        const tableNumber = document.getElementById("tableNumber").value;
        if (!tableNumber) {
            showToast("テーブル番号が見つかりません。", "error");
            return;
        }

        loadOrdersFromStorage();
        const items = Object.entries(orders)
            .map(([name, { count }]) => `${name} x ${toNumber(count)}`)
            .join(", ");
        const total = toNumber(document.getElementById("totalPrice").textContent);
        if (!items) {
            showToast("注文が空です。", "error");
            return;
        }
        const confirmationLines = Object.entries(orders)
            .map(([name, { count }]) => `・${name} x ${toNumber(count)}`)
            .join("\n");
        const totalQty = Object.values(orders).reduce((sum, entry) => sum + Math.max(0, toNumber(entry && entry.count)), 0);
        const totalPrice = toNumber(document.getElementById("totalPrice").textContent);
        const confirmMessage =
            "以下の内容で送信します。\n\n" +
            `${confirmationLines}\n\n` +
            `合計点数: ${totalQty}点\n` +
            `合計金額: ${totalPrice}円`;
        if (!confirm(confirmMessage)) return;
        const hasHighQtyLine = Object.values(orders).some(
            (entry) => Math.max(0, toNumber(entry && entry.count)) >= highQtyConfirmThreshold
        );
        if (hasHighQtyLine) {
            const extraMessage =
                `${highQtyConfirmThreshold}点以上の注文が含まれています。\n` +
                "数量に間違いがないか最終確認してください。";
            if (!confirm(extraMessage)) return;
        }
        const orderLines = Object.entries(orders).map(([displayName, entry]) => ({
            displayName,
            itemName: String(entry.itemName || "").trim(),
            options: Array.isArray(entry.options) ? entry.options : [],
            quantity: Math.max(1, toNumber(entry.count))
        }));

        let activeGroupId = getGroupId();
        if (immediateSubmitMode) {
            try {
                if (!skipStorePreflightInImmediateMode) {
                    await ensureStoreOpenForOrder();
                }
                // 会計済みの古いgroupIdへ誤送信されると、会計待ち金額が過去分と混ざる。
                // そのため immediate mode でも group の状態確認だけは必ず実施する。
                activeGroupId = await ensureCurrentGroupIsActive(tableNumber);
            } catch (_) {
                showToast("現在は注文を受け付けていません。", "error");
                return;
            }
        } else {
            try {
                const preflight = await Promise.all([
                    ensureStoreOpenForOrder(),
                    ensureCurrentGroupIsActive(tableNumber)
                ]);
                activeGroupId = preflight[1];
            } catch (_) {
                showToast("現在は注文を受け付けていません。", "error");
                return;
            }
        }

        const dateText = currentDateText();
        const payload = {
            orderId: `o-${Date.now()}-${Math.floor(Math.random() * 100000)}`,
            date: dateText,
            table: tableNumber,
            items,
            total,
            groupId: activeGroupId,
            sig: tableSigFromUrl,
            orderLines
        };

        if (confirmBtn) {
            confirmBtn.textContent = "送信中...";
        }

        let sentSuccessfully = false;
        try {
            if (resendQueueEnabled) {
                // 先にキューへ退避してから送ることで、送信途中失敗でも注文を失わない。
                enqueueOrder(payload);
            }
            if (useImmediateMode) {
                // 非同期送信: UIは即時反映し、検証はバックグラウンドで実施。
                sendOrderPayload(payload)
                    .then(() => verifyOrderAcceptedInBackground(payload))
                    .catch(() => {
                        if (resendQueueEnabled) {
                            flushSendQueueInBackground();
                            return;
                        }
                        showToast("送信に失敗しました。通信を確認して再送してください。", "error");
                    });
            } else {
                await sendOrderPayload(payload);
                const accepted = await waitOrderAccepted(payload.orderId, dateText, {
                    timeoutMs: quickOrderAckTimeoutMs,
                    pollIntervalMs: quickOrderAckPollIntervalMs
                });
                if (accepted) {
                    if (resendQueueEnabled) dequeueOrderById(payload.orderId);
                } else {
                    throw new Error("order not accepted yet");
                }
            }
            sentSuccessfully = true;
        } catch (error) {
            console.error(error);
            if (String(error && error.message || "").indexOf("store closed") >= 0) {
                showToast("現在は注文を受け付けていません。", "error");
            } else if (!resendQueueEnabled) {
                showToast("送信確認ができませんでした。通信を確認して再送してください。", "error");
            } else {
                showToast("送信に失敗したため、再送キューに保存しました。", "error");
            }
            return;
        }

        if (!sentSuccessfully) return;

        const historyLines = Object.entries(orders).map(([name, entry]) => {
            const quantity = Math.max(1, toNumber(entry && entry.count));
            const unitPrice = Math.max(0, toNumber(entry && entry.price));
            return {
                name: String(name || "").trim(),
                quantity,
                unitPrice,
                lineTotal: unitPrice * quantity
            };
        });
        loadHistoryFromStorage();
        orderHistory.push({
            table: tableNumber,
            groupId: activeGroupId,
            items,
            total,
            orderId: payload.orderId,
            date: dateText,
            createdAt: new Date().toISOString(),
            lines: historyLines
        });
        saveHistoryToStorage();
        renderHistory();

        sessionStorage.removeItem(getStorageKey());
        Object.keys(orders).forEach((key) => delete orders[key]);
        renderOrder();
        toggleOrderModal();
        if (useImmediateMode) {
            showToast("注文を受け付けました。", "success");
            return;
        }
        showToast("注文を送信しました。", "success");
    } finally {
        isSubmitting = false;
        if (confirmBtn) {
            confirmBtn.disabled = false;
            confirmBtn.textContent = originalLabel;
        }
        renderQueueBadge();
    }
}

window.addEventListener("DOMContentLoaded", async () => {
    if (!tableNumberFromUrl) {
        blockApp("Missing or invalid table parameter. Open with ?table=T01");
        return;
    }
    if (!tableSigFromUrl) {
        blockApp("Missing or invalid signature parameter. Open with ?table=T01&sig=...");
        return;
    }

    ensureGroupId();
    purgeSendQueueIfDisabled();
    if (resendQueueEnabled) {
        migrateLegacyQueueIfNeeded();
    }
    renderQueueBadge();
    if (resendQueueEnabled) {
        if (navigator.onLine) {
            window.setTimeout(() => {
                flushSendQueueInBackground();
            }, 0);
        }
        window.addEventListener("online", () => {
            flushSendQueueInBackground();
        });
    }

    document.getElementById("tableNumber").value = tableNumberFromUrl;

    try {
        allMenuItems = await loadCSV();
        if (allMenuItems.length === 0) {
            document.getElementById("menuContainer").textContent = "メニューが見つかりません。";
            return;
        }
        selectedCategory = allMenuItems[0]["カテゴリ"] || "";
        renderCategories(allMenuItems);
        renderMenuItems();
        renderOrder();
    } catch (error) {
        console.error(error);
        document.getElementById("menuContainer").textContent =
            "メニューの読み込みに失敗しました。時間をおいて再試行してください。";
    }
});

