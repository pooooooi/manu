const csvUrl = "https://docs.google.com/spreadsheets/d/1dNk8uLhzl06UJeIsMRYoyLd_MAoHuIpV-qqYIyf8ZS8/export?format=csv&gid=100058082";

let allMenuItems = [];
let selectedCategory = "";
const orders = {};
const orderHistory = [];
const urlParams = new URLSearchParams(window.location.search);
const tableNumberFromUrl = urlParams.get('table');
const groupId = sessionStorage.getItem("groupId") || "";
const payload = {
    orders,
    groupId,
    tableNumber,
    // そのほか必要な情報
};

const orderData = {
  table: tableNumberFromUrl,
  groupId: getGroupId(),  // ← 追加
  orders: orders,
  timestamp: new Date().toISOString()
};

// ✅ トークン認証処理（無効なら即停止）
const token = urlParams.get("token");

// 仮の有効トークン一覧（必要に応じて変更)
const VALID_TOKENS = ["abc123", "def456"];

if (!token || !VALID_TOKENS.includes(token)) {
  document.body.innerHTML = "<h2 style='color:red;text-align:center;margin-top:100px;'>アクセス権限がありません（無効なトークン）</h2>";
  throw new Error("無効なトークンでブロックされました。");
}

async function loadCSV() {
    const res = await fetch(csvUrl);
    const text = await res.text();

    const rows = text.trim().split(/\r?\n/).map(r => r.split(','));
    const headers = rows[0].map(h => h.trim().replace(/^"|"$/g, ''));
    return rows.slice(1).map(r => {
        const obj = {};
        headers.forEach((h, i) => {
            obj[h] = r[i]?.trim().replace(/^"|"$/g, '');
        });
        return obj;
    });
}

function renderCategories(items) {
    const categories = [...new Set(items.map(item => item["カテゴリ"]))];
    const btnContainer = document.getElementById("categoryButtons");
    btnContainer.innerHTML = "";

    categories.forEach(cat => {
        const btn = document.createElement("button");
        btn.textContent = cat;
        btn.classList.add("category-btn");

        // 選択されたカテゴリをクリックしたら色変更
        btn.onclick = () => {
            selectedCategory = cat;
            renderMenuItems();
            document.querySelectorAll('.category-buttons button').forEach(b => b.classList.remove('selected'));
            btn.classList.add('selected');
        };

        btnContainer.appendChild(btn);

        // 最初のカテゴリボタンを選択状態にしておく
        if (cat === selectedCategory) {
            btn.classList.add('selected');
        }
    });
}


function renderMenuItems() {
    const container = document.getElementById("menuContainer");
    container.innerHTML = "";

    const items = selectedCategory
        ? allMenuItems.filter(item => item["カテゴリ"] === selectedCategory)
        : allMenuItems;

    items.forEach(item => {
        const div = document.createElement("div");
        div.className = "menuItem";
        div.innerHTML = `
      <img src="${item["画像URL"]}" alt="${item["商品名"]}" />
      <div class="menu-text">
      <h4>${item["商品名"]}</h4>
      <p>${item["金額"]} 円</p>
      </div>
    `;
        div.onclick = () => showOptions(item);
        container.appendChild(div);
    });
}

// function renderMenuItems() {
//     const container = document.getElementById("menuContainer");
//     container.innerHTML = "";
//     allMenuItems.forEach(item => {
//         const btn = document.createElement("button");
//         btn.textContent = item["商品名"];
//         btn.onclick = () => showOptions(item);
//         container.appendChild(btn);
//     });
// }

function addToOrder(item) {
    const name = item["商品名"];
    const price = parseInt(item["金額"]);
    if (!orders[name]) {
        orders[name] = { count: 1, price };
    } else {
        orders[name].count++;
    }
    renderOrder();
}

function renderOrder() {
    const storageKey = `orders-${tableNumberFromUrl || 'default'}`;
    const storedOrders = JSON.parse(sessionStorage.getItem(storageKey)) || {};
    Object.assign(orders, storedOrders);
    const list = document.getElementById("orderItems");
    list.innerHTML = "";
    let total = 0;
    let itemCount = 0;
    Object.entries(orders).forEach(([name, { count, price }]) => {
        const li = document.createElement("li");
        li.textContent = `${name} x ${count} = ${price * count} 円 `;

        // −ボタン
        const minusBtn = document.createElement("button");
        minusBtn.textContent = "−";
        minusBtn.addEventListener("click", () => decreaseItem(name));
        li.appendChild(minusBtn);

        // 削除ボタン
        // const removeBtn = document.createElement("button");
        // removeBtn.textContent = "削除";
        // removeBtn.addEventListener("click", () => removeItem(name));
        // li.appendChild(removeBtn);

        total += price * count;
        itemCount += count;
        list.appendChild(li);
    });
    document.getElementById("totalPrice").textContent = total;
    // バッジの更新
    const badge = document.getElementById("orderBadge");
    if (itemCount > 0) {
        badge.textContent = itemCount;
        badge.style.display = "inline-block";
    } else {
        badge.textContent = "0";
        badge.style.display = "inline-block";
    }
}
function renderHistory() {
    const historyList = document.getElementById("historyItems");
    historyList.innerHTML = "";
    let total = 0;

    orderHistory.forEach(h => {
        const li = document.createElement("li");
        li.textContent = `テーブル${h.table}：${h.items} 合計${h.total}円`;
        historyList.appendChild(li);
        total += parseInt(h.total);
    });

    document.getElementById("historyTotal").textContent = total;
}
function clearHistory() {
    if (!confirm("本当に清算して、注文履歴を削除しますか？")) return;

    const historyKey = `order-history-${tableNumberFromUrl || 'default'}`;
    sessionStorage.removeItem(historyKey);  // ← テーブルごとの履歴だけ削除

    orderHistory.length = 0;  // メモリ上の履歴も消す
    renderHistory();

    alert("注文履歴をクリアしました。");
}
function decreaseItem(name) {
    if (orders[name]) {
        orders[name].count--;
        if (orders[name].count <= 0) {
            delete orders[name];
        }
        const storageKey = `orders-${tableNumberFromUrl || 'default'}`;
        sessionStorage.setItem(storageKey, JSON.stringify(orders));
        renderOrder();
    }
}
function removeItem(name) {
    delete orders[name];
    const storageKey = `orders-${tableNumberFromUrl || 'default'}`;
    sessionStorage.setItem(storageKey, JSON.stringify(orders));
    renderOrder();
}
function toggleOrderModal() {
    const modal = document.getElementById("orderModal");
    modal.style.display = modal.style.display === "none" ? "block" : "none";
}
function toggleHistoryModal() {
    const modal = document.getElementById("historyModal");
    modal.style.display = modal.style.display === "none" ? "block" : "none";
}
let selectedItem = null;

function showOptions(item) {
    selectedItem = item;
    document.getElementById("optionTitle").textContent = item["商品名"];
    const optionList = document.getElementById("optionList");
    optionList.innerHTML = "";

    let i = 1;
    while (item[`オプション${i}`]) {
        const name = item[`オプション${i}`];
        const price = item[`オプション${i}金額`] || 0;
        const label = document.createElement("label");
        label.innerHTML = `<input type="checkbox" value="${name}:${price}"> ${name}（+${price}円）`;
        optionList.appendChild(label);
        optionList.appendChild(document.createElement("br"));
        i++;
    }

    document.getElementById("optionModal").style.display = "flex";
}
function closeOrderModal() {
    document.getElementById("orderModal").style.display = "none";
}

function closeModal() {
    // document.getElementById("optionModal").style.display = "none";
    const modal = document.getElementById("optionModal");
    modal.style.display = modal.style.display === "none" ? "block" : "none";
}

function addOptionsToOrder() {
    const baseName = selectedItem["商品名"];
    const basePrice = parseInt(selectedItem["金額"]);

    const checkboxes = document.querySelectorAll('#optionList input[type="checkbox"]');
    let selectedNames = [];
    let extraPrice = 0;

    checkboxes.forEach(cb => {
        if (cb.checked) {
            const [name, price] = cb.value.split(':');
            selectedNames.push(name);
            extraPrice += parseInt(price);
        }
    });

    //  チェックされたものが0なら警告（ここを変更）
    if (selectedNames.length === 0) {
        alert("オプションが追加されていません");
        return;
    }

    const fullName = selectedNames.length > 0
        ? `${baseName}（${selectedNames.join(", ")}）`
        : baseName;

    if (!orders[fullName]) {
        orders[fullName] = { count: 1, price: basePrice + extraPrice };
    } else {
        orders[fullName].count++;
    }

    const storageKey = `orders-${tableNumberFromUrl || 'default'}`;
    sessionStorage.setItem(storageKey, JSON.stringify(orders));
    renderOrder();
    closeModal();
    alert("注文リストに追加されました。");
}

function addItemWithoutOptions() {
    const baseName = selectedItem["商品名"];
    const basePrice = parseInt(selectedItem["金額"]);

    if (!orders[baseName]) {
        orders[baseName] = { count: 1, price: basePrice };
    } else {
        orders[baseName].count++;
    }

    const storageKey = `orders-${tableNumberFromUrl || 'default'}`;
    sessionStorage.setItem(storageKey, JSON.stringify(orders));
    renderOrder();
    closeModal();
    alert("注文リストに追加されました。");
}

function getGroupId() {
  let groupId = sessionStorage.getItem('groupId');
  if (!groupId) {
    groupId = 'G' + Date.now() + '-' + Math.floor(Math.random() * 100000);
    sessionStorage.setItem('groupId', groupId);
  }
  return groupId;
}

function ensureGroupId() {
    const urlParams = new URLSearchParams(window.location.search);
    let groupId = urlParams.get("group");
    if (!groupId) {
        groupId = `grp-${Date.now()}`;
        urlParams.set("group", groupId);
        const newUrl = `${window.location.pathname}?${urlParams.toString()}`;
        window.history.replaceState({}, "", newUrl);
    }
    sessionStorage.setItem("groupId", groupId);
    return groupId;
}

function getTodaySheet() {
  const today = new Date();
  const sheetName = Utilities.formatDate(today, Session.getScriptTimeZone(), "yyyy-MM-dd");
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) throw new Error(`シート「${sheetName}」が見つかりません。`);
  return sheet;
}

function getPreviousTotal(sheet, tableNumber) {
  const data = sheet.getDataRange().getValues();
  let lastTotal = 0;
  for (let i = data.length - 1; i >= 1; i--) {
    if (data[i][1] == tableNumber) {  // [1] = テーブル番号列
      lastTotal = data[i][5];         // [5] = 合計列
      break;
    }
  }
  return Number(lastTotal) || 0;
}

function submitOrder() {
    const historyKey = `order-history-${tableNumberFromUrl || 'default'}`;
    const storedHistory = JSON.parse(sessionStorage.getItem(historyKey)) || [];
    const tableNumber = document.getElementById("tableNumber").value;
    const items = Object.entries(orders)
        .map(([name, { count }]) => `${name} x ${count}`)
        .join(", ");
    const total = document.getElementById("totalPrice").textContent;
    // storedHistory.push({ table: tableNumber, items, total });
    sessionStorage.setItem(historyKey, JSON.stringify(storedHistory));

    if (!tableNumber) {
        alert("テーブル番号を入力してください");
        return;
    }
    if (!confirm("注文を確定します。よろしいですか？")) {
        return; // 「いいえ」の場合は何もしない
    }


    // ====== 注文履歴へ追加（テーブルごとに保存） ======
    storedHistory.push({ table: tableNumber, items, total });
    sessionStorage.setItem(historyKey, JSON.stringify(storedHistory));

    orderHistory.length = 0;
    orderHistory.push(...storedHistory);
    renderHistory();
    // const formUrl = "https://docs.google.com/forms/d/e/1FAIpQLScbYOi6dsyUuIXclTKtrr6DeeZMg_WYXzNCFELm5hay0hrx4g/formResponse";
    // const data = new FormData();
    // data.append("entry.408172505", tableNumber);
    // data.append("entry.1132597987", items);
    // data.append("entry.418961724", total);

    // fetch(formUrl, {
    //     method: "POST",
    //     mode: "no-cors",
    //     body: data,
    // });

    // ✅ GAS APIに送信
    const endpoint = "https://script.google.com/macros/s/AKfycbw8ED-mVd7I8Vhw8l7oWh_beRFtRxk3-i0AHBR0K1EmkH8BWDFlTP3V58kF7h3KE7-5/exec";  // ←ここを自分のに変更！
    fetch(endpoint, {
        method: "POST",
        mode: "no-cors",
        body: JSON.stringify({ table: tableNumber, items, total, groupId: getGroupId()}),
        headers: {
            "Content-Type": "application/json",
        },
    });

    // ====== 注文リスト削除（テーブルごとに消すよう修正） ======
    const storageKey = `orders-${tableNumberFromUrl || 'default'}`;
    sessionStorage.removeItem(storageKey);
    alert("注文を送信しました！");
    toggleOrderModal();
    Object.keys(orders).forEach(key => delete orders[key]); // 注文データをクリア
    renderOrder(); // 表示を更新
}
function recordOrder(data) {
  const sheet = getTodaySheet();
  const prevTotal = getPreviousTotal(sheet, data.tableNumber);
  const newTotal = prevTotal + data.subtotal;

  sheet.appendRow([
    new Date(),
    data.tableNumber,
    data.orderId,
    data.items.join(", "),
    data.subtotal,
    newTotal
  ]);
}

window.addEventListener("DOMContentLoaded", () => {
    const groupId = ensureGroupId();
    console.log("このグループのID:", groupId);
});

window.onload = async () => {
    allMenuItems = await loadCSV();
    if (tableNumberFromUrl) {
        document.getElementById("tableNumber").value = tableNumberFromUrl;
    }
    // 最初のカテゴリだけ表示するよう修正
    selectedCategory = allMenuItems[0]["カテゴリ"];
    renderCategories(allMenuItems);
    renderMenuItems();
    renderOrder();  // ← 必ずここで呼ぶ
};