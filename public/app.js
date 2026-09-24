const accountsElement = document.querySelector("#accounts");
const emptyState = document.querySelector("#empty-state");
const accountDialog = document.querySelector("#account-dialog");
const qrDialog = document.querySelector("#qr-dialog");
const accountForm = document.querySelector("#account-form");
const messageForm = document.querySelector("#message-form");
const sender = document.querySelector("#sender");
const toast = document.querySelector("#toast");
let accounts = [];
let qrInterval;

function refreshIcons() {
  window.lucide?.createIcons();
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 3200);
}

async function request(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "No se pudo completar la operacion.");
  return data;
}

function renderAccounts() {
  accountsElement.querySelectorAll(".account-card").forEach((card) => card.remove());
  emptyState.hidden = accounts.length > 0;
  for (const account of accounts) {
    const statusClass = account.status === "esperando QR" ? "waiting" : account.status;
    const card = document.createElement("article");
    card.className = "account-card";
    card.innerHTML = `
      <p class="account-name"></p>
      <p class="account-phone"></p>
      <div class="account-meta">
        <span class="account-status ${statusClass}">${account.status}</span>
        <span class="account-actions">
          <button class="text-button" data-action="qr" data-id="${account.id}" type="button">${account.hasQr ? "Ver QR" : "Vincular"}</button>
          <button class="text-button delete" data-action="delete" data-id="${account.id}" type="button">Eliminar</button>
        </span>
      </div>`;
    card.querySelector(".account-name").textContent = account.name;
    card.querySelector(".account-phone").textContent = account.phone || "Sin numero vinculado";
    accountsElement.append(card);
  }

  const connected = accounts.filter((account) => account.status === "conectada");
  const needsAttention = accounts.filter((account) => account.status !== "conectada").length;
  document.querySelector("#account-count").textContent = accounts.length;
  document.querySelector("#online-count").textContent = connected.length;
  document.querySelector("#attention-count").textContent = needsAttention;
  document.querySelector("#sidebar-account-count").textContent = accounts.length;
  sender.innerHTML = '<option value="">Selecciona una cuenta conectada</option>';
  connected.forEach((account) => {
    const option = new Option(`${account.name}${account.phone ? ` - ${account.phone}` : ""}`, account.id);
    sender.add(option);
  });
  sender.disabled = connected.length === 0;
  refreshIcons();
}

async function loadAccounts() {
  try {
    ({ accounts } = await request("/api/accounts"));
    renderAccounts();
  } catch (error) {
    showToast(error.message);
  }
}

async function openQr(accountId) {
  const account = accounts.find((item) => item.id === accountId);
  document.querySelector("#qr-title").textContent = account?.name || "Escanea el QR";
  qrDialog.showModal();
  const updateQr = async () => {
    try {
      const data = await request(`/api/accounts/${accountId}/qr`);
      const frame = document.querySelector("#qr-frame");
      const status = document.querySelector("#qr-status");
      status.textContent = data.status === "conectada" ? "Cuenta vinculada correctamente." : "Abre WhatsApp en tu telefono y vincula un dispositivo.";
      frame.innerHTML = data.qr ? `<img src="${data.qr}" alt="Codigo QR de WhatsApp">` : `<span>${data.status === "conectada" ? "Cuenta vinculada" : "Generando QR..."}</span>`;
      if (data.status === "conectada") {
        clearInterval(qrInterval);
        loadAccounts();
      }
    } catch (error) { showToast(error.message); }
  };
  clearInterval(qrInterval);
  updateQr();
  qrInterval = setInterval(updateQr, 3000);
}

function showAccountDialog() {
  accountDialog.showModal();
  document.querySelector("#account-name").focus();
}

document.querySelectorAll("#add-account-button, #add-account-button-secondary, #empty-add-account").forEach((button) => {
  button.addEventListener("click", showAccountDialog);
});
document.querySelector("#cancel-account").addEventListener("click", () => accountDialog.close());
document.querySelector("#close-qr").addEventListener("click", () => qrDialog.close());
qrDialog.addEventListener("close", () => clearInterval(qrInterval));

accountForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = document.querySelector("#account-name").value;
  try {
    const { account } = await request("/api/accounts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
    accountForm.reset();
    accountDialog.close();
    await loadAccounts();
    openQr(account.id);
  } catch (error) { showToast(error.message); }
});

accountsElement.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  if (button.dataset.action === "qr") openQr(button.dataset.id);
  if (button.dataset.action === "delete" && confirm("Se eliminara la sesion y sus credenciales locales. Continuar?")) {
    try { await request(`/api/accounts/${button.dataset.id}`, { method: "DELETE" }); await loadAccounts(); showToast("Cuenta eliminada."); } catch (error) { showToast(error.message); }
  }
});

messageForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = document.querySelector("#send-button");
  button.disabled = true;
  try {
    await request(`/api/accounts/${sender.value}/messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ to: document.querySelector("#recipient").value, text: document.querySelector("#message").value }) });
    document.querySelector("#message").value = "";
    showToast("Mensaje enviado.");
  } catch (error) { showToast(error.message); }
  button.disabled = false;
});

loadAccounts();
setInterval(loadAccounts, 10000);
refreshIcons();