const csvUrl = "https://docs.google.com/spreadsheets/d/1dNk8uLhzl06UJeIsMRYoyLd_MAoHuIpV-qqYIyf8ZS8/export?format=csv&gid=100058082";

let allMenuItems = [];
let selectedCategory = "";
const orders = {};
const orderHistory = [];

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
        btn.onclick = () => {
            selectedCategory = cat;
            renderMenuItems();
            document.querySelectorAll('.category-buttons button').forEach(b => b.classList.remove('selected'));
            btn.classList.add('selected');
        };
        btnContainer.appendChild(btn);
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
      <h4>${item["商品名"]}</h4>
      <p>${item["金額"]} 円</p>
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
    const storedOrders = JSON.parse(sessionStorage.getItem('orders')) || {};
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

    sessionStorage.setItem('orders', JSON.stringify(orders));
    renderOrder();
    closeModal();
    alert("注文リストに追加されました。");
}


function submitOrder() {
    const tableNumber = document.getElementById("tableNumber").value;
    if (!tableNumber) {
        alert("テーブル番号を入力してください");
        return;
    }
    if (!confirm("注文を確定します。よろしいですか？")) {
        return; // 「いいえ」の場合は何もしない
    }
    const items = Object.entries(orders)
        .map(([name, { count }]) => `${name} x ${count}`)
        .join(", ");
    const total = document.getElementById("totalPrice").textContent;

        // 注文履歴に追加
    orderHistory.push({ table: tableNumber, items, total });
    renderHistory();

    const formUrl = "https://docs.google.com/forms/d/e/1FAIpQLScbYOi6dsyUuIXclTKtrr6DeeZMg_WYXzNCFELm5hay0hrx4g/formResponse";
    const data = new FormData();
    data.append("entry.408172505", tableNumber);
    data.append("entry.1132597987", items);
    data.append("entry.418961724", total);

    fetch(formUrl, {
        method: "POST",
        mode: "no-cors",
        body: data,
    });

    sessionStorage.removeItem('orders'); // 確定後リセット
    alert("注文を送信しました！");
    toggleOrderModal();
    Object.keys(orders).forEach(key => delete orders[key]); // 注文データをクリア
    renderOrder(); // 表示を更新
}

window.onload = async () => {
    allMenuItems = await loadCSV();
    renderCategories(allMenuItems);
    renderMenuItems();
    renderOrder();  // ← 必ずここで呼ぶ
};