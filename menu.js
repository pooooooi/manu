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

function getHistoryKey() {
    return `order-history-${tableNumberFromUrl}`;
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
    const count = Math.max(0, toNumber(entry.count));
    const price = Math.max(0, toNumber(entry.price));
    const parsed = parseOrderName(name);
    const itemName = String(entry.itemName || parsed.itemName || "").trim();
    const options = Array.isArray(entry.options)
        ? entry.options.map((s) => String(s).trim()).filter(Boolean)
        : parsed.options;
    return { count, price, itemName, options };
}

function loadSendQueue() {
    const queue = readJsonStorage(localStorage, getSendQueueKey(), []);
    return Array.isArray(queue) ? queue : [];
}

function saveSendQueue(queue) {
    localStorage.setItem(getSendQueueKey(), JSON.stringify(queue));
    renderQueueBadge();
}

function enqueueOrder(payload) {
    const queue = loadSendQueue();
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
        orders[name] = normalizeOrderEntry(name, entry || {});
    });
}

function saveOrdersToStorage() {
    sessionStorage.setItem(getStorageKey(), JSON.stringify(orders));
}

function loadHistoryFromStorage() {
    const storedHistory = readJsonStorage(sessionStorage, getHistoryKey(), []);
    orderHistory.length = 0;
    if (Array.isArray(storedHistory)) {
        orderHistory.push(...storedHistory);
    }
}

function saveHistoryToStorage() {
    sessionStorage.setItem(getHistoryKey(), JSON.stringify(orderHistory));
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

    Object.entries(orders).forEach(([name, order]) => {
        const count = toNumber(order.count);
        const price = toNumber(order.price);
        const li = document.createElement("li");
        li.textContent = `${name} x ${count} = ${price * count} 円`;

        const minusBtn = document.createElement("button");
        minusBtn.type = "button";
        minusBtn.textContent = "-";
        minusBtn.addEventListener("click", () => decreaseItem(name));
        li.appendChild(minusBtn);

        total += price * count;
        itemCount += count;
        list.appendChild(li);
    });

    document.getElementById("totalPrice").textContent = String(total);
    const badge = document.getElementById("orderBadge");
    badge.textContent = String(itemCount);
    badge.style.display = "inline-block";
}

function renderHistory() {
    const historyList = document.getElementById("historyItems");
    historyList.innerHTML = "";
    let total = 0;

    orderHistory.forEach((h) => {
        const li = document.createElement("li");
        li.textContent = `テーブル${h.table}: ${h.items} 合計 ${h.total}円`;
        historyList.appendChild(li);
        total += toNumber(h.total);
    });

    document.getElementById("historyTotal").textContent = String(total);
}

function clearHistory() {
    if (!confirm("本当に履歴をクリアしますか？")) return;
    sessionStorage.removeItem(getHistoryKey());
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

function toggleOrderModal() {
    const modal = document.getElementById("orderModal");
    modal.style.display = modal.style.display === "block" ? "none" : "block";
}

function toggleHistoryModal() {
    const modal = document.getElementById("historyModal");
    if (modal.style.display === "block") {
        modal.style.display = "none";
        return;
    }
    loadHistoryFromStorage();
    renderHistory();
    modal.style.display = "block";
}

let selectedItem = null;

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
        const input = document.createElement("input");
        input.type = "checkbox";
        input.value = `opt-${i}`;
        input.dataset.optionName = String(name || "");
        input.dataset.optionPrice = String(price);
        label.appendChild(input);
        label.appendChild(document.createTextNode(` ${name} (+${price}円)`));

        optionList.appendChild(label);
        optionList.appendChild(document.createElement("br"));
        optionCount++;
        i++;
    }

    if (addOptionsBtn) {
        addOptionsBtn.style.display = optionCount > 0 ? "inline-block" : "none";
    }
    if (addWithoutOptionsBtn) {
        addWithoutOptionsBtn.style.display = "inline-block";
    }
    if (optionCount === 0) {
        optionList.textContent = "この商品はオプションを選べません。";
    }

    document.getElementById("optionModal").style.display = "flex";
}

function closeModal() {
    const addOptionsBtn = document.getElementById("addOptionsBtn");
    const addWithoutOptionsBtn = document.getElementById("addWithoutOptionsBtn");
    const optionImageWrap = document.getElementById("optionImageWrap");
    const optionImage = document.getElementById("optionImage");
    if (addOptionsBtn) addOptionsBtn.style.display = "inline-block";
    if (addWithoutOptionsBtn) addWithoutOptionsBtn.style.display = "inline-block";
    if (optionImageWrap) optionImageWrap.classList.remove("is-visible");
    if (optionImage) {
        optionImage.removeAttribute("src");
        optionImage.alt = "";
    }
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
        orders[fullName].count = toNumber(orders[fullName].count) + 1;
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
        orders[baseName].count = toNumber(orders[baseName].count) + 1;
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

async function waitOrderAccepted(orderId, dateText) {
    const started = Date.now();
    while (Date.now() - started < 12000) {
        const url = `${endpoint}?action=checkOrder&date=${encodeURIComponent(
            dateText
        )}&table=${encodeURIComponent(tableNumberFromUrl)}&orderId=${encodeURIComponent(
            orderId
        )}&sig=${encodeURIComponent(tableSigFromUrl)}`;
        const data = await jsonpFetch(url);
        if (data && data.result === "OK" && data.exists) return true;
        await new Promise((r) => window.setTimeout(r, 700));
    }
    return false;
}

async function submitOrder() {
    if (isSubmitting) return;
    const tableNumber = document.getElementById("tableNumber").value;
    if (!tableNumber) {
        showToast("テーブル番号が見つかりません。", "error");
        return;
    }
    if (!confirm("注文を送信します。よろしいですか？")) return;
    try {
        await ensureStoreOpenForOrder();
    } catch (_) {
        showToast("現在は注文を受け付けていません。", "error");
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
    const orderLines = Object.entries(orders).map(([displayName, entry]) => ({
        displayName,
        itemName: String(entry.itemName || "").trim(),
        options: Array.isArray(entry.options) ? entry.options : [],
        quantity: Math.max(1, toNumber(entry.count))
    }));

    const dateText = currentDateText();
    const activeGroupId = await ensureCurrentGroupIsActive(tableNumber);
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

    const confirmBtn = document.getElementById("confirmOrderBtn");
    const originalLabel = confirmBtn ? confirmBtn.textContent : "";
    let sentSuccessfully = false;

    try {
        isSubmitting = true;
        if (confirmBtn) {
            confirmBtn.disabled = true;
            confirmBtn.textContent = "送信中...";
        }
        await sendOrderPayload(payload);
        const accepted = await waitOrderAccepted(payload.orderId, dateText);
        if (!accepted) {
            throw new Error("order not accepted yet");
        }
        sentSuccessfully = true;
    } catch (error) {
        console.error(error);
        if (String(error && error.message || "").indexOf("store closed") >= 0) {
            showToast("現在は注文を受け付けていません。", "error");
        } else {
            try {
                enqueueOrder(payload);
                showToast("送信に失敗したため、再送キューに保存しました。", "error");
            } catch (queueError) {
                console.error(queueError);
                showToast("送信と再送保存に失敗しました。通信状況を確認してください。", "error");
            }
        }
        return;
    } finally {
        isSubmitting = false;
        if (confirmBtn) {
            confirmBtn.disabled = false;
            confirmBtn.textContent = originalLabel;
        }
        renderQueueBadge();
    }

    if (!sentSuccessfully) return;

    loadHistoryFromStorage();
    orderHistory.push({ table: tableNumber, items, total });
    saveHistoryToStorage();
    renderHistory();

    sessionStorage.removeItem(getStorageKey());
    Object.keys(orders).forEach((key) => delete orders[key]);
    renderOrder();
    toggleOrderModal();
    showToast("注文を送信しました。", "success");
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
    migrateLegacyQueueIfNeeded();
    renderQueueBadge();
    if (navigator.onLine) {
        window.setTimeout(() => {
            flushSendQueueInBackground();
        }, 0);
    }
    window.addEventListener("online", () => {
        flushSendQueueInBackground();
    });

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

