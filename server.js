const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { createCipheriv, createDecipheriv, createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } = require("node:crypto");
const makeWASocket = require("@whiskeysockets/baileys").default;
const { DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = require("@whiskeysockets/baileys");
const QRCode = require("qrcode");

const port = Number.parseInt(process.env.PORT, 10) || 3000;
const publicDirectory = path.join(__dirname, "public");
const dataDirectory = path.join(__dirname, "data");
const sessionsDirectory = path.join(dataDirectory, "sessions");
const logsDirectory = path.join(dataDirectory, "logs");
const accountsFile = path.join(dataDirectory, "accounts.json");
const connections = new Map();
const logAccessChallenges = new Map();
const logAccessTokens = new Map();
const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml"
};

fs.mkdirSync(sessionsDirectory, { recursive: true });
fs.mkdirSync(logsDirectory, { recursive: true });

function loadEncryptionKey() {
  if (process.env.LOG_ENCRYPTION_KEY) {
    const key = Buffer.from(process.env.LOG_ENCRYPTION_KEY, "base64");
    if (key.length !== 32) {
      throw new Error("LOG_ENCRYPTION_KEY debe contener 32 bytes codificados en base64.");
    }
    return key;
  }

  const keyFile = path.join(dataDirectory, "log-encryption.key");
  try {
    return Buffer.from(fs.readFileSync(keyFile, "utf8"), "base64");
  } catch {
    const key = randomBytes(32);
    fs.writeFileSync(keyFile, key.toString("base64"), { mode: 0o600 });
    return key;
  }
}

const logEncryptionKey = loadEncryptionKey();

function loadAccounts() {
  try {
    return JSON.parse(fs.readFileSync(accountsFile, "utf8"));
  } catch {
    return [];
  }
}

let accounts = loadAccounts();

function saveAccounts() {
  fs.writeFileSync(accountsFile, JSON.stringify(accounts, null, 2));
}

function publicAccount(account) {
  const connection = connections.get(account.id);
  return {
    id: account.id,
    name: account.name,
    status: connection?.status || "desconectada",
    phone: connection?.phone || null,
    hasQr: Boolean(connection?.qr),
    apiKeyPrefix: account.apiKeyPrefix || null,
    createdAt: account.createdAt
  };
}

function hashApiKey(apiKey) {
  return createHash("sha256").update(apiKey).digest("hex");
}

function createApiKey() {
  const apiKey = `wa_${randomBytes(24).toString("base64url")}`;
  return { apiKey, apiKeyHash: hashApiKey(apiKey), apiKeyPrefix: apiKey.slice(0, 11) };
}

function encryptLogEntry(entry) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", logEncryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(entry), "utf8"), cipher.final()]);
  return JSON.stringify({ iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: ciphertext.toString("base64") });
}

function decryptLogEntry(line) {
  const encrypted = JSON.parse(line);
  const decipher = createDecipheriv("aes-256-gcm", logEncryptionKey, Buffer.from(encrypted.iv, "base64"));
  decipher.setAuthTag(Buffer.from(encrypted.tag, "base64"));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(encrypted.data, "base64")), decipher.final()]).toString("utf8"));
}

function logFileFor(accountId) {
  return path.join(logsDirectory, `${accountId}.jsonl`);
}

function appendMessageLog(accountId, entry) {
  fs.appendFileSync(logFileFor(accountId), `${encryptLogEntry({ ...entry, timestamp: new Date().toISOString() })}\n`, { mode: 0o600 });
}

function readMessageLogs(accountId, limit = 100) {
  try {
    return fs.readFileSync(logFileFor(accountId), "utf8").trim().split("\n").filter(Boolean).map(decryptLogEntry).slice(-limit);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

function extractMessageText(message) {
  return message?.conversation || message?.extendedTextMessage?.text || message?.imageMessage?.caption || message?.videoMessage?.caption || "[Mensaje no textual]";
}

function authorizeApiKey(request) {
  const apiKey = request.headers["x-api-key"];
  if (!apiKey || typeof apiKey !== "string") return null;
  const hash = hashApiKey(apiKey);
  return accounts.find((account) => account.apiKeyHash && timingSafeEqual(Buffer.from(account.apiKeyHash), Buffer.from(hash))) || null;
}

function createLogAccessToken(accountId) {
  const token = randomBytes(32).toString("base64url");
  logAccessTokens.set(token, { accountId, expiresAt: Date.now() + 15 * 60_000 });
  return token;
}

function hasLogAccess(accountId, token) {
  const access = logAccessTokens.get(token);
  if (!access || access.expiresAt < Date.now() || access.accountId !== accountId) {
    logAccessTokens.delete(token);
    return false;
  }
  return true;
}

function sendJson(response, statusCode, data) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(data));
}

function normalizePhone(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15) {
    return null;
  }
  return `${digits}@s.whatsapp.net`;
}

async function readBody(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 1_000_000) {
      throw new Error("El contenido excede el limite permitido.");
    }
  }
  return body ? JSON.parse(body) : {};
}

async function connectAccount(account) {
  const existing = connections.get(account.id);
  if (existing?.isConnecting || existing?.status === "conectada") {
    return;
  }

  const connection = { status: "conectando", qr: null, phone: null, isConnecting: true, socket: null, cancelled: false };
  connections.set(account.id, connection);

  try {
    const { state, saveCreds } = await useMultiFileAuthState(path.join(sessionsDirectory, account.id));
    if (connection.cancelled || !accounts.some((item) => item.id === account.id)) {
      fs.rmSync(path.join(sessionsDirectory, account.id), { recursive: true, force: true });
      return;
    }
    const { version } = await fetchLatestBaileysVersion();
    if (connection.cancelled || !accounts.some((item) => item.id === account.id)) {
      return;
    }
    const socket = makeWASocket({
      auth: state,
      version,
      printQRInTerminal: false,
      syncFullHistory: false,
      markOnlineOnConnect: false
    });

    connection.socket = socket;
    socket.ev.on("creds.update", saveCreds);
    socket.ev.on("messages.upsert", ({ type, messages }) => {
      if (connection.cancelled || !accounts.some((item) => item.id === account.id)) return;
      if (type !== "notify") return;
      for (const message of messages) {
        if (!message.message || message.key.fromMe) continue;
        appendMessageLog(account.id, {
          id: message.key.id,
          direction: "inbound",
          from: message.key.remoteJid?.replace("@s.whatsapp.net", "") || "desconocido",
          text: extractMessageText(message.message)
        });
      }
    });
    socket.ev.on("connection.update", async ({ connection: stateName, lastDisconnect, qr }) => {
      if (connection.cancelled || !accounts.some((item) => item.id === account.id)) {
        socket.end(undefined);
        return;
      }
      if (qr) {
        connection.qr = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
        connection.status = "esperando QR";
      }

      if (stateName === "open") {
        connection.status = "conectada";
        connection.qr = null;
        connection.phone = socket.user?.id?.split(":")[0] || null;
      }

      if (stateName === "close") {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;
        connection.status = "desconectada";
        connection.qr = null;
        connection.socket = null;
        connection.isConnecting = false;
        if (!loggedOut && !connection.cancelled && accounts.some((item) => item.id === account.id)) {
          setTimeout(() => connectAccount(account), 3000);
        }
      }
    });
  } catch (error) {
    connection.status = "error";
    connection.error = error.message;
    connection.isConnecting = false;
  }
}

function serveStatic(requestUrl, response) {
  const relativePath = requestUrl.pathname === "/" ? "index.html" : requestUrl.pathname.slice(1);
  const filePath = path.resolve(publicDirectory, relativePath);
  if (!filePath.startsWith(`${publicDirectory}${path.sep}`)) {
    response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Acceso no permitido");
    return;
  }
  fs.readFile(filePath, (error, content) => {
    if (error) {
      response.writeHead(error.code === "ENOENT" ? 404 : 500, { "Content-Type": "text/plain; charset=utf-8" });
      response.end(error.code === "ENOENT" ? "Pagina no encontrada" : "Error interno del servidor");
      return;
    }
    response.writeHead(200, { "Content-Type": contentTypes[path.extname(filePath).toLowerCase()] || "application/octet-stream" });
    response.end(content);
  });
}

const server = http.createServer(async (request, response) => {
  const requestUrl = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  const accountMatch = requestUrl.pathname.match(/^\/api\/accounts\/([\w-]+)(?:\/(qr|messages|api-key|log-access|logs))?$/);

  try {
    if (request.method === "GET" && requestUrl.pathname === "/api/accounts") {
      sendJson(response, 200, { accounts: accounts.map(publicAccount) });
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/accounts") {
      const body = await readBody(request);
      const name = String(body.name || "").trim();
      if (!name || name.length > 48) {
        sendJson(response, 400, { error: "Indica un nombre de cuenta de hasta 48 caracteres." });
        return;
      }
      const apiKey = createApiKey();
      const account = { id: randomUUID(), name, apiKeyHash: apiKey.apiKeyHash, apiKeyPrefix: apiKey.apiKeyPrefix, createdAt: new Date().toISOString() };
      accounts.push(account);
      saveAccounts();
      connectAccount(account);
      sendJson(response, 201, { account: publicAccount(account), apiKey: apiKey.apiKey });
      return;
    }

    if (requestUrl.pathname === "/v1/messages") {
      const account = authorizeApiKey(request);
      if (!account) {
        sendJson(response, 401, { error: "X-API-Key invalida o ausente." });
        return;
      }
      const connection = connections.get(account.id);
      if (request.method === "POST") {
        const body = await readBody(request);
        const recipient = normalizePhone(body.to);
        const text = String(body.text || "").trim();
        if (!recipient || !text || text.length > 4096) {
          sendJson(response, 400, { error: "Indica un numero internacional valido y un mensaje de hasta 4096 caracteres." });
          return;
        }
        if (!connection?.socket || connection.status !== "conectada") {
          sendJson(response, 409, { error: "La cuenta debe estar conectada antes de enviar mensajes." });
          return;
        }
        const message = await connection.socket.sendMessage(recipient, { text });
        appendMessageLog(account.id, { id: message.key.id, direction: "outbound", to: recipient.replace("@s.whatsapp.net", ""), text });
        sendJson(response, 201, { id: message.key.id, status: "enviado", accountId: account.id });
        return;
      }
      if (request.method === "GET") {
        const accessToken = request.headers["x-log-access-token"];
        if (!hasLogAccess(account.id, accessToken)) {
          sendJson(response, 403, { error: "Se requiere X-Log-Access-Token desbloqueado desde el dashboard." });
          return;
        }
        const limit = Math.min(Math.max(Number.parseInt(requestUrl.searchParams.get("limit"), 10) || 50, 1), 100);
        sendJson(response, 200, { accountId: account.id, messages: readMessageLogs(account.id, limit) });
        return;
      }
    }

    if (accountMatch) {
      const [, accountId, action] = accountMatch;
      const account = accounts.find((item) => item.id === accountId);
      if (!account) {
        sendJson(response, 404, { error: "Cuenta no encontrada." });
        return;
      }
      const connection = connections.get(accountId);

      if (request.method === "GET" && action === "qr") {
        sendJson(response, 200, { qr: connection?.qr || null, status: connection?.status || "desconectada" });
        return;
      }

      if (request.method === "POST" && action === "api-key") {
        const apiKey = createApiKey();
        account.apiKeyHash = apiKey.apiKeyHash;
        account.apiKeyPrefix = apiKey.apiKeyPrefix;
        saveAccounts();
        sendJson(response, 201, { apiKey: apiKey.apiKey, apiKeyPrefix: apiKey.apiKeyPrefix });
        return;
      }

      if (request.method === "POST" && action === "log-access") {
        if (!connection?.socket || connection.status !== "conectada" || !connection.phone) {
          sendJson(response, 409, { error: "La cuenta debe estar conectada para enviar el codigo de acceso." });
          return;
        }
        const code = String(randomInt(100000, 1_000_000));
        await connection.socket.sendMessage(`${connection.phone}@s.whatsapp.net`, { text: `WA Control: tu codigo para ver el registro cifrado es ${code}. Expira en 10 minutos.` });
        logAccessChallenges.set(account.id, { codeHash: hashApiKey(code), expiresAt: Date.now() + 10 * 60_000, attempts: 0 });
        sendJson(response, 200, { status: "codigo_enviado", expiresIn: 600 });
        return;
      }

      if (request.method === "PUT" && action === "log-access") {
        const body = await readBody(request);
        const challenge = logAccessChallenges.get(account.id);
        const code = String(body.code || "");
        if (!challenge || challenge.expiresAt < Date.now() || challenge.attempts >= 5) {
          logAccessChallenges.delete(account.id);
          sendJson(response, 401, { error: "El codigo expiro o ya no es valido. Solicita uno nuevo." });
          return;
        }
        challenge.attempts += 1;
        if (!timingSafeEqual(Buffer.from(challenge.codeHash), Buffer.from(hashApiKey(code)))) {
          sendJson(response, 401, { error: "Codigo incorrecto." });
          return;
        }
        logAccessChallenges.delete(account.id);
        sendJson(response, 200, { accessToken: createLogAccessToken(account.id), expiresIn: 900 });
        return;
      }

      if (request.method === "GET" && action === "logs") {
        const accessToken = request.headers["x-log-access-token"];
        if (!hasLogAccess(account.id, accessToken)) {
          sendJson(response, 403, { error: "Desbloquea el registro con el codigo enviado a WhatsApp." });
          return;
        }
        sendJson(response, 200, { messages: readMessageLogs(account.id) });
        return;
      }

      if (request.method === "POST" && action === "messages") {
        const body = await readBody(request);
        const recipient = normalizePhone(body.to);
        const text = String(body.text || "").trim();
        if (!recipient || !text || text.length > 4096) {
          sendJson(response, 400, { error: "Indica un numero internacional valido y un mensaje de hasta 4096 caracteres." });
          return;
        }
        if (!connection?.socket || connection.status !== "conectada") {
          sendJson(response, 409, { error: "La cuenta debe estar conectada antes de enviar mensajes." });
          return;
        }
        const message = await connection.socket.sendMessage(recipient, { text });
        appendMessageLog(account.id, { id: message.key.id, direction: "outbound", to: recipient.replace("@s.whatsapp.net", ""), text });
        sendJson(response, 201, { id: message.key.id, status: "enviado" });
        return;
      }

      if (request.method === "DELETE" && !action) {
        if (connection) connection.cancelled = true;
        connection?.socket?.end(undefined);
        connections.delete(accountId);
        accounts = accounts.filter((item) => item.id !== accountId);
        saveAccounts();
        fs.rmSync(path.join(sessionsDirectory, accountId), { recursive: true, force: true });
        fs.rmSync(logFileFor(accountId), { force: true });
        sendJson(response, 200, { deleted: true });
        return;
      }
    }

    serveStatic(requestUrl, response);
  } catch (error) {
    sendJson(response, 500, { error: error instanceof SyntaxError ? "JSON invalido." : error.message || "Error interno." });
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Dashboard disponible en http://localhost:${port}`);
  accounts.forEach((account) => connectAccount(account));
});
