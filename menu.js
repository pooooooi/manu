const csvUrl = "https://docs.google.com/spreadsheets/d/1dNk8uLhzl06UJeIsMRYoyLd_MAoHuIpV-qqYIyf8ZS8/export?format=csv&gid=100058082";

let allMenuItems = [];
let selectedCategory = "";
const orders = {};
const orderHistory = [];
const urlParams = new URLSearchParams(window.location.search);
const tableNumberFromUrl = urlParams.get('table');

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
        li.innerHTML = `
          ${name} x ${count} = ${price * count} 円
          <button onclick="decreaseItem('${name}')">−</button>
          <button onclick="removeItem('${name}')">削除</button>
        `;
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
        sessionStorage.setItem('orders', JSON.stringify(orders));
        renderOrder();
    }
}
function removeItem(name) {
    delete orders[name];
    sessionStorage.setItem('orders', JSON.stringify(orders));
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
    document.getElementById("optionModal").style.display = "none";
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


function submitOrder() {
    const historyKey = `order-history-${tableNumberFromUrl || 'default'}`;
    const storedHistory = JSON.parse(sessionStorage.getItem(historyKey)) || [];
    const tableNumber = document.getElementById("tableNumber").value;
    const items = Object.entries(orders)
        .map(([name, { count }]) => `${name} x ${count}`)
        .join(", ");
    const total = document.getElementById("totalPrice").textContent;
    storedHistory.push({ table: tableNumber, items, total });
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
    const endpoint = "https://script.google.com/macros/s/AKfycbyHnXGvyB0xaWYqfaf2W-9tS9_Pi_P0VT4W_GMWzZbUhENKln4QkZUwFNraKGVoYoCkbw/exec";  // ←ここを自分のに変更！
    fetch(endpoint, {
        method: "POST",
        body: JSON.stringify({ table: tableNumber, items, total }),
        headers: {
            "Content-Type": "application/json",
        },
    }).then(() => {
        alert("注文を送信しました！");
        sessionStorage.removeItem(`orders-${tableNumberFromUrl || 'default'}`);
        Object.keys(orders).forEach(key => delete orders[key]);
        renderOrder();
        toggleOrderModal();
    }).catch(err => {
        alert("送信に失敗しました");
        console.error(err);
    });

    // ====== 注文リスト削除（テーブルごとに消すよう修正） ======
    const storageKey = `orders-${tableNumberFromUrl || 'default'}`;
    sessionStorage.removeItem(storageKey);
    alert("注文を送信しました！");
    toggleOrderModal();
    Object.keys(orders).forEach(key => delete orders[key]); // 注文データをクリア
    renderOrder(); // 表示を更新
}

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