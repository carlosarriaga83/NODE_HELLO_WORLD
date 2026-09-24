const accountsElement = document.querySelector("#accounts");
const emptyState = document.querySelector("#empty-state");
const accountDialog = document.querySelector("#account-dialog");
const qrDialog = document.querySelector("#qr-dialog");
const linkDialog = document.querySelector("#link-dialog");
const accountForm = document.querySelector("#account-form");
const messageForm = document.querySelector("#message-form");
const sender = document.querySelector("#sender");
const toast = document.querySelector("#toast");
let accounts = [];
let qrInterval;
let selectedAccountId = null;
let selectedLinkAccountId = null;
let currentApiKey = null;
let currentLogAccessToken = null;
const themeToggle = document.querySelector("#theme-toggle");

function applyTheme(theme) {
  const isLight = theme === "light";
  document.documentElement.dataset.theme = isLight ? "light" : "dark";
  themeToggle.innerHTML = `<i data-lucide="${isLight ? "moon" : "sun"}"></i>`;
  themeToggle.title = isLight ? "Cambiar a modo dark" : "Cambiar a modo light";
  themeToggle.setAttribute("aria-label", themeToggle.title);
  refreshIcons();
}

function loadTheme() {
  const savedTheme = localStorage.getItem("wa-control-theme");
  applyTheme(savedTheme === "light" ? "light" : "dark");
}

themeToggle.addEventListener("click", () => {
  const nextTheme = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  localStorage.setItem("wa-control-theme", nextTheme);
  applyTheme(nextTheme);
});

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
          ${account.status === "conectada" ? "" : `<button class="text-button" data-action="link" data-id="${account.id}" type="button">Vincular</button>`}
          <button class="text-button" data-action="api-key" data-id="${account.id}" type="button">API key</button>
          <button class="text-button" data-action="logs" data-id="${account.id}" type="button">Log</button>
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

function accountName(accountId) {
  return accounts.find((account) => account.id === accountId)?.name || "Cuenta";
}

function showApiKey(accountId, apiKey) {
  currentApiKey = apiKey;
  document.querySelector("#api-key-title").textContent = `API key: ${accountName(accountId)}`;
  document.querySelector("#api-key-value").textContent = apiKey;
  document.querySelector("#api-key-dialog").showModal();
}

async function requestLogCode(accountId) {
  await request(`/api/accounts/${accountId}/log-access`, { method: "POST" });
  document.querySelector("#log-request-step").hidden = true;
  document.querySelector("#log-code-form").hidden = false;
  document.querySelector("#log-code").focus();
  showToast("Codigo enviado a la cuenta de WhatsApp.");
}

async function loadLogs() {
  const filters = new URLSearchParams();
  [["query", "#log-query"], ["contact", "#log-contact"], ["direction", "#log-direction"], ["from", "#log-from"], ["to", "#log-to"]].forEach(([key, selector]) => {
    const value = document.querySelector(selector).value.trim();
    if (value) filters.set(key, value);
  });
  const { messages } = await request(`/api/accounts/${selectedAccountId}/logs?${filters}`, { headers: { "X-Log-Access-Token": currentLogAccessToken } });
  const container = document.querySelector("#message-logs");
  container.replaceChildren();
  if (!messages.length) {
    container.innerHTML = '<p class="logs-empty">Aun no hay mensajes registrados para esta cuenta.</p>';
  }
  messages.slice().reverse().forEach((message) => {
    const item = document.createElement("article");
    item.className = `log-entry ${message.direction}`;
    const meta = document.createElement("p");
    meta.textContent = `${message.direction === "inbound" ? "Recibido de" : "Enviado a"} ${message.from || message.to || "desconocido"} - ${new Date(message.timestamp).toLocaleString("es-MX")}`;
    const text = document.createElement("p");
    text.textContent = message.text;
    item.append(meta, text);
    container.append(item);
  });
  document.querySelector("#log-results-count").textContent = `${messages.length} ${messages.length === 1 ? "mensaje" : "mensajes"}`;
}

async function showLogs(accountId, accessToken) {
  selectedAccountId = accountId;
  currentLogAccessToken = accessToken;
  document.querySelector("#log-filters").reset();
  document.querySelector("#logs-title").textContent = `Log: ${accountName(accountId)}`;
  document.querySelector("#logs-dialog").showModal();
  await loadLogs();
}

async function requestApiKeyCode(accountId) {
  await request(`/api/accounts/${accountId}/api-key-access`, { method: "POST" });
  document.querySelector("#api-key-request-step").hidden = true;
  document.querySelector("#api-key-code-form").hidden = false;
  document.querySelector("#api-key-code").focus();
  showToast("Codigo enviado a la cuenta de WhatsApp.");
}

function showAccountDialog() {
  accountDialog.showModal();
  document.querySelector("#account-name").focus();
}

function openLinkDialog(accountId) {
  selectedLinkAccountId = accountId;
  document.querySelector("#link-title").textContent = `Vincular: ${accountName(accountId)}`;
  document.querySelector("#pairing-code-form").reset();
  document.querySelector("#link-options").hidden = false;
  document.querySelector("#pairing-code-result").hidden = true;
  linkDialog.showModal();
  document.querySelector("#pairing-phone").focus();
}

async function requestPairingCode() {
  const phone = document.querySelector("#pairing-phone").value;
  const { code } = await request(`/api/accounts/${selectedLinkAccountId}/pairing-code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone })
  });
  document.querySelector("#pairing-code").textContent = code;
  document.querySelector("#link-options").hidden = true;
  document.querySelector("#pairing-code-result").hidden = false;
  await loadAccounts();
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
    openLinkDialog(account.id);
  } catch (error) { showToast(error.message); }
});

accountsElement.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  if (button.dataset.action === "link") {
    openLinkDialog(button.dataset.id);
  }
  if (button.dataset.action === "api-key") {
    selectedAccountId = button.dataset.id;
    document.querySelector("#api-key-access-title").textContent = `API key: ${accountName(selectedAccountId)}`;
    document.querySelector("#api-key-request-step").hidden = false;
    document.querySelector("#api-key-code-form").hidden = true;
    document.querySelector("#api-key-access-dialog").showModal();
  }
  if (button.dataset.action === "logs") {
    selectedAccountId = button.dataset.id;
    document.querySelector("#log-access-title").textContent = `Abrir Log: ${accountName(selectedAccountId)}`;
    document.querySelector("#log-request-step").hidden = false;
    document.querySelector("#log-code-form").hidden = true;
    document.querySelector("#log-access-dialog").showModal();
  }
  if (button.dataset.action === "delete" && confirm("Se eliminara la sesion y sus credenciales locales. Continuar?")) {
    try { await request(`/api/accounts/${button.dataset.id}`, { method: "DELETE" }); await loadAccounts(); showToast("Cuenta eliminada."); } catch (error) { showToast(error.message); }
  }
});

document.querySelector("#link-with-qr").addEventListener("click", () => {
  linkDialog.close();
  openQr(selectedLinkAccountId);
});
document.querySelector("#pairing-code-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try { await requestPairingCode(); } catch (error) { showToast(error.message); }
});
document.querySelector("#new-pairing-code").addEventListener("click", async () => {
  try { await requestPairingCode(); } catch (error) { showToast(error.message); }
});

document.querySelector("#request-api-key-code").addEventListener("click", async () => {
  try { await requestApiKeyCode(selectedAccountId); } catch (error) { showToast(error.message); }
});
document.querySelector("#api-key-code-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const { apiKey } = await request(`/api/accounts/${selectedAccountId}/api-key-access`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: document.querySelector("#api-key-code").value }) });
    document.querySelector("#api-key-code-form").reset();
    document.querySelector("#api-key-access-dialog").close();
    showApiKey(selectedAccountId, apiKey);
    await loadAccounts();
  } catch (error) { showToast(error.message); }
});

document.querySelectorAll(".code-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".code-tab").forEach((item) => item.classList.toggle("active", item === tab));
    document.querySelectorAll(".code-example[data-code-example]").forEach((example) => {
      const active = example.dataset.codeExample === tab.dataset.codeTab;
      example.hidden = !active;
      example.classList.toggle("active", active);
    });
  });
});

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    showToast("Copiado al portapapeles.");
  } catch {
    showToast("No se pudo copiar el contenido.");
  }
}

document.querySelectorAll(".copy-code").forEach((button) => {
  button.addEventListener("click", () => copyText(document.querySelector(`#${button.dataset.copyTarget}`).textContent));
});
document.querySelector("#copy-agent-prompt").addEventListener("click", () => copyText(document.querySelector("#agent-prompt-text").textContent));

document.querySelectorAll("[data-close-dialog]").forEach((button) => {
  button.addEventListener("click", () => document.querySelector(`#${button.dataset.closeDialog}`).close());
});
document.querySelector("#copy-api-key").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(currentApiKey); showToast("API key copiada."); } catch { showToast("No se pudo copiar la API key."); }
});
document.querySelector("#request-log-code").addEventListener("click", async () => {
  try { await requestLogCode(selectedAccountId); } catch (error) { showToast(error.message); }
});
document.querySelector("#log-code-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const { accessToken } = await request(`/api/accounts/${selectedAccountId}/log-access`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: document.querySelector("#log-code").value }) });
    document.querySelector("#log-code-form").reset();
    document.querySelector("#log-access-dialog").close();
    await showLogs(selectedAccountId, accessToken);
  } catch (error) { showToast(error.message); }
});
document.querySelector("#log-filters").addEventListener("submit", async (event) => {
  event.preventDefault();
  try { await loadLogs(); } catch (error) { showToast(error.message); }
});
document.querySelector("#clear-log-filters").addEventListener("click", async () => {
  document.querySelector("#log-filters").reset();
  try { await loadLogs(); } catch (error) { showToast(error.message); }
});

function activateView() {
  const view = ["resumen", "cuentas", "mensajes", "wiki"].includes(location.hash.slice(1)) ? location.hash.slice(1) : "resumen";
  document.querySelector("#app-main").dataset.activeView = view;
  document.querySelectorAll("[data-view-link]").forEach((link) => link.classList.toggle("active", link.dataset.viewLink === view));
  document.querySelector(".topbar-context strong").textContent = ({ resumen: "Resumen", cuentas: "Cuentas", mensajes: "Mensajes", wiki: "API Wiki" })[view];
}

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
window.addEventListener("hashchange", activateView);
activateView();
loadTheme();
refreshIcons();