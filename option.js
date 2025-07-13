window.onload = () => {
    const item = JSON.parse(sessionStorage.getItem('selectedItem'));
    const optionList = document.getElementById("optionList");
    optionList.innerHTML = "";

    let i = 1;
    while (item[`オプション${i}`]) {
        const name = item[`オプション${i}`];
        const price = parseInt(item[`オプション${i}金額`] || 0);
        const label = document.createElement("label");
        label.innerHTML = `<input type="checkbox" value="${name}:${price}"> ${name}（+${price}円）`;
        optionList.appendChild(label);
        optionList.appendChild(document.createElement("br"));
        i++;
    }

    const btn = document.createElement("button");
    btn.textContent = "オプションを追加";
    btn.onclick = addOptionsToOrder;
    optionList.appendChild(btn);
};

function addOptionsToOrder() {
    const item = JSON.parse(sessionStorage.getItem('selectedItem'));
    const baseName = item["商品名"];
    const basePrice = parseInt(item["金額"]);

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

    const orders = JSON.parse(sessionStorage.getItem('orders')) || {};

    if (!orders[fullName]) {
        orders[fullName] = { count: 1, price: basePrice + extraPrice };
    } else {
        orders[fullName].count++;
    }

    sessionStorage.setItem('orders', JSON.stringify(orders));
    alert("注文リストに追加されました。");
    window.location.href = "index.html";
}
