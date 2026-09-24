const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { createCipheriv, createDecipheriv, createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } = require("node:crypto");
const makeWASocket = require("@whiskeysockets/baileys").default;
const { DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = require("@whiskeysockets/baileys");
const QRCode = require("qrcode");
const mysql = require("mysql2/promise");

const port = Number.parseInt(process.env.PORT, 10) || 3000;
const publicDirectory = path.join(__dirname, "public");
const dataDirectory = path.join(__dirname, "data");
const sessionsDirectory = path.join(dataDirectory, "sessions");
const logsDirectory = path.join(dataDirectory, "logs");
const accountsFile = path.join(dataDirectory, "accounts.json");
const connections = new Map();
const logAccessChallenges = new Map();
const logAccessTokens = new Map();
const apiKeyAccessChallenges = new Map();
const contactCache = new Map();
const loadedContactAccounts = new Set();
const databaseVariablesPresent = ["DB_HOST", "DB_NAME", "DB_USER", "DB_PASSWORD"].some((key) => process.env[key]);
const databaseEnabled = ["DB_HOST", "DB_NAME", "DB_USER", "DB_PASSWORD"].every((key) => process.env[key]);
const database = databaseEnabled
  ? mysql.createPool({
      host: process.env.DB_HOST === "localhost" ? "127.0.0.1" : process.env.DB_HOST,
      port: Number.parseInt(process.env.DB_PORT, 10) || 3306,
      database: process.env.DB_NAME,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      waitForConnections: true,
      connectionLimit: 5
    })
  : null;
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
    if (databaseEnabled) {
      return createHash("sha256").update(process.env.DB_PASSWORD).digest();
    }
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

async function initializeStorage() {
  if (!database) return;

  await database.query(`
    CREATE TABLE IF NOT EXISTS wa_accounts (
      id CHAR(36) PRIMARY KEY,
      name VARCHAR(48) NOT NULL,
      api_key_hash CHAR(64) NULL,
      api_key_prefix VARCHAR(16) NULL,
      created_at DATETIME(3) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await database.query("ALTER TABLE wa_accounts MODIFY api_key_hash CHAR(64) NULL, MODIFY api_key_prefix VARCHAR(16) NULL");
  await database.query(`
    CREATE TABLE IF NOT EXISTS wa_message_logs (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      account_id CHAR(36) NOT NULL,
      encrypted_entry LONGTEXT NOT NULL,
      created_at DATETIME(3) NOT NULL,
      INDEX wa_message_logs_account_created (account_id, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await database.query(`
    CREATE TABLE IF NOT EXISTS wa_session_files (
      account_id CHAR(36) NOT NULL,
      file_name VARCHAR(255) NOT NULL,
      file_content LONGTEXT NOT NULL,
      updated_at DATETIME(3) NOT NULL,
      PRIMARY KEY (account_id, file_name),
      CONSTRAINT wa_session_files_account_fk FOREIGN KEY (account_id) REFERENCES wa_accounts(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await database.query(`
    CREATE TABLE IF NOT EXISTS wa_contacts (
      account_id CHAR(36) NOT NULL,
      jid VARCHAR(191) NOT NULL,
      display_name VARCHAR(160) NULL,
      photo_url TEXT NULL,
      updated_at DATETIME(3) NOT NULL,
      PRIMARY KEY (account_id, jid),
      CONSTRAINT wa_contacts_account_fk FOREIGN KEY (account_id) REFERENCES wa_accounts(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  const [existing] = await database.query("SELECT COUNT(*) AS count FROM wa_accounts");
  if (Number(existing[0].count) === 0 && accounts.length > 0) {
    for (const account of accounts) {
      await database.execute(
        "INSERT INTO wa_accounts (id, name, api_key_hash, api_key_prefix, created_at) VALUES (?, ?, ?, ?, ?)",
        [account.id, account.name, account.apiKeyHash, account.apiKeyPrefix, new Date(account.createdAt)]
      );
      try {
        const entries = fs.readFileSync(logFileFor(account.id), "utf8").trim().split("\n").filter(Boolean);
        for (const entry of entries) {
          await database.execute(
            "INSERT INTO wa_message_logs (account_id, encrypted_entry, created_at) VALUES (?, ?, ?)",
            [account.id, entry, new Date()]
          );
        }
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }

  const [storedAccounts] = await database.query(
    "SELECT id, name, api_key_hash AS apiKeyHash, api_key_prefix AS apiKeyPrefix, created_at AS createdAt FROM wa_accounts ORDER BY created_at"
  );
  accounts = storedAccounts.map((account) => ({ ...account, createdAt: new Date(account.createdAt).toISOString() }));
}

async function persistAccount(account) {
  if (!database) {
    saveAccounts();
    return;
  }
  await database.execute(
    `INSERT INTO wa_accounts (id, name, api_key_hash, api_key_prefix, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE name = VALUES(name), api_key_hash = VALUES(api_key_hash), api_key_prefix = VALUES(api_key_prefix)`,
    [account.id, account.name, account.apiKeyHash, account.apiKeyPrefix, new Date(account.createdAt)]
  );
}

async function restoreSessionFiles(accountId) {
  if (!database) return;
  const sessionPath = path.join(sessionsDirectory, accountId);
  const [files] = await database.execute(
    "SELECT file_name AS fileName, file_content AS fileContent FROM wa_session_files WHERE account_id = ?",
    [accountId]
  );
  if (!files.length) return;
  fs.mkdirSync(sessionPath, { recursive: true });
  for (const file of files) {
    fs.writeFileSync(path.join(sessionPath, file.fileName), file.fileContent, "utf8");
  }
}

async function persistSessionFiles(accountId) {
  if (!database) return;
  const sessionPath = path.join(sessionsDirectory, accountId);
  let fileNames;
  try {
    fileNames = fs.readdirSync(sessionPath).filter((fileName) => fileName.endsWith(".json"));
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  for (const fileName of fileNames) {
    const fileContent = fs.readFileSync(path.join(sessionPath, fileName), "utf8");
    await database.execute(
      `INSERT INTO wa_session_files (account_id, file_name, file_content, updated_at)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE file_content = VALUES(file_content), updated_at = VALUES(updated_at)`,
      [accountId, fileName, fileContent, new Date()]
    );
  }
}

async function clearSessionFiles(accountId) {
  fs.rmSync(path.join(sessionsDirectory, accountId), { recursive: true, force: true });
  if (database) {
    await database.execute("DELETE FROM wa_session_files WHERE account_id = ?", [accountId]);
  }
}

function contactMapFor(accountId) {
  if (!contactCache.has(accountId)) contactCache.set(accountId, new Map());
  return contactCache.get(accountId);
}

function contactName(contact) {
  return contact.name || contact.notify || contact.verifiedName || contact.username || null;
}

async function persistContacts(accountId, incomingContacts) {
  const storedContacts = [];
  for (const contact of incomingContacts) {
    for (const jid of [...new Set([contact.id, contact.phoneNumber].filter(Boolean))]) {
      const existing = contactMapFor(accountId).get(jid) || {};
      const stored = {
        jid,
        name: contactName(contact) || existing.name || null,
        photoUrl: contact.imgUrl && contact.imgUrl !== "changed" ? contact.imgUrl : existing.photoUrl || null
      };
      contactMapFor(accountId).set(jid, stored);
      storedContacts.push(stored);
    }
  }
  if (!database) return;
  for (let index = 0; index < storedContacts.length; index += 100) {
    const batch = storedContacts.slice(index, index + 100);
    const placeholders = batch.map(() => "(?, ?, ?, ?, ?)").join(", ");
    const values = batch.flatMap((contact) => [accountId, contact.jid, contact.name, contact.photoUrl, new Date()]);
    await database.execute(
      `INSERT INTO wa_contacts (account_id, jid, display_name, photo_url, updated_at)
       VALUES ${placeholders}
       ON DUPLICATE KEY UPDATE display_name = COALESCE(VALUES(display_name), display_name), photo_url = COALESCE(VALUES(photo_url), photo_url), updated_at = VALUES(updated_at)`,
      values
    );
  }
}

async function persistContact(accountId, contact) {
  await persistContacts(accountId, [contact]);
}

async function loadContacts(accountId) {
  const contacts = contactMapFor(accountId);
  if (!database || loadedContactAccounts.has(accountId)) return contacts;
  const [rows] = await database.execute(
    "SELECT jid, display_name AS name, photo_url AS photoUrl FROM wa_contacts WHERE account_id = ?",
    [accountId]
  );
  rows.forEach((contact) => {
    if (!contacts.has(contact.jid)) contacts.set(contact.jid, contact);
  });
  loadedContactAccounts.add(accountId);
  return contacts;
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

async function appendMessageLog(accountId, entry) {
  const encryptedEntry = encryptLogEntry({ ...entry, timestamp: new Date().toISOString() });
  if (!database) {
    fs.appendFileSync(logFileFor(accountId), `${encryptedEntry}\n`, { mode: 0o600 });
    return;
  }
  await database.execute(
    "INSERT INTO wa_message_logs (account_id, encrypted_entry, created_at) VALUES (?, ?, ?)",
    [accountId, encryptedEntry, new Date()]
  );
}

async function readMessageLogs(accountId, limit = 100) {
  if (database) {
    const [rows] = await database.execute(
      "SELECT encrypted_entry FROM wa_message_logs WHERE account_id = ? ORDER BY created_at DESC, id DESC LIMIT ?",
      [accountId, limit]
    );
    return rows.reverse().map((row) => decryptLogEntry(row.encrypted_entry));
  }
  try {
    return fs.readFileSync(logFileFor(accountId), "utf8").trim().split("\n").filter(Boolean).map(decryptLogEntry).slice(-limit);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function findMessageLogs(accountId, filters) {
  const requestedLimit = Math.min(Math.max(Number.parseInt(filters.limit, 10) || 50, 1), 100);
  const direction = ["inbound", "outbound"].includes(filters.direction) ? filters.direction : null;
  const query = String(filters.query || "").trim().toLocaleLowerCase();
  const contact = String(filters.contact || "").replace(/\D/g, "");
  const fromDate = /^\d{4}-\d{2}-\d{2}$/.test(filters.from) ? new Date(`${filters.from}T00:00:00.000Z`) : null;
  const toDate = /^\d{4}-\d{2}-\d{2}$/.test(filters.to) ? new Date(`${filters.to}T23:59:59.999Z`) : null;
  const messages = await readMessageLogs(accountId, 500);
  return messages.filter((message) => {
    const timestamp = new Date(message.timestamp);
    const counterparty = String(message.from || message.to || "");
    return (!direction || message.direction === direction)
      && (!contact || counterparty.includes(contact))
      && (!query || `${counterparty} ${message.text || ""}`.toLocaleLowerCase().includes(query))
      && (!fromDate || timestamp >= fromDate)
      && (!toDate || timestamp <= toDate);
  }).slice(-requestedLimit);
}

function messageContact(message) {
  const value = message.jid || message.from || message.to || "desconocido";
  return value.includes("@") ? value : `${value}@s.whatsapp.net`;
}

async function buildInbox(accountId, filters) {
  const messages = await readMessageLogs(accountId, 500);
  const contacts = await loadContacts(accountId);
  const query = String(filters.query || "").trim().toLocaleLowerCase();
  const direction = ["inbound", "outbound"].includes(filters.direction) ? filters.direction : null;
  const requestedContact = String(filters.contact || "");
  const conversations = new Map();

  for (const message of messages) {
    const jid = messageContact(message);
    const contact = contacts.get(jid) || {};
    const name = message.contactName || contact.name || jid.split("@")[0];
    const searchable = `${name} ${jid} ${message.text || ""}`.toLocaleLowerCase();
    if (query && !searchable.includes(query)) continue;
    if (direction && message.direction !== direction) continue;
    const summary = conversations.get(jid) || { jid, name, photoUrl: contact.photoUrl || null, lastMessage: "", timestamp: message.timestamp, count: 0 };
    summary.name = message.contactName || contact.name || summary.name;
    summary.lastMessage = message.text || "";
    summary.timestamp = message.timestamp;
    summary.count += 1;
    conversations.set(jid, summary);
  }

  const sortedConversations = [...conversations.values()].sort((left, right) => new Date(right.timestamp) - new Date(left.timestamp));
  const connection = connections.get(accountId);
  await Promise.all(sortedConversations.slice(0, 30).map(async (conversation) => {
    if (conversation.photoUrl || !connection?.socket) return;
    try {
      conversation.photoUrl = await connection.socket.profilePictureUrl(conversation.jid, "preview", 3000) || null;
      if (conversation.photoUrl) await persistContact(accountId, { id: conversation.jid, name: conversation.name, imgUrl: conversation.photoUrl });
    } catch {}
  }));

  const selectedMessages = requestedContact
    ? messages.filter((message) => messageContact(message) === requestedContact && (!direction || message.direction === direction) && (!query || `${message.contactName || ""} ${message.text || ""}`.toLocaleLowerCase().includes(query)))
    : [];
  return { conversations: sortedConversations, messages: selectedMessages };
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

async function sendVerificationCode(account, challenges, label) {
  const connection = connections.get(account.id);
  if (!connection?.socket || connection.status !== "conectada" || !connection.phone) {
    const error = new Error("La cuenta debe estar conectada para enviar el codigo de verificacion.");
    error.statusCode = 409;
    throw error;
  }
  const code = String(randomInt(100000, 1_000_000));
  await connection.socket.sendMessage(`${connection.phone}@s.whatsapp.net`, { text: `WA Control: tu codigo para ${label} es ${code}. Expira en 10 minutos.` });
  challenges.set(account.id, { codeHash: hashApiKey(code), expiresAt: Date.now() + 10 * 60_000, attempts: 0 });
}

function verifyCode(accountId, challenges, code) {
  const challenge = challenges.get(accountId);
  if (!challenge || challenge.expiresAt < Date.now() || challenge.attempts >= 5) {
    challenges.delete(accountId);
    return false;
  }
  challenge.attempts += 1;
  const valid = timingSafeEqual(Buffer.from(challenge.codeHash), Buffer.from(hashApiKey(code)));
  if (valid) challenges.delete(accountId);
  return valid;
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

function normalizePairingPhone(phone) {
  const recipient = normalizePhone(phone);
  return recipient?.replace("@s.whatsapp.net", "") || null;
}

async function waitForSocket(account) {
  void connectAccount(account);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const connection = connections.get(account.id);
    if (connection?.socket) return connection;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("La sesion todavia se esta preparando. Intenta de nuevo en unos segundos.");
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

  const connection = { status: "conectando", qr: null, phone: null, isConnecting: true, socket: null, cancelled: false, linkMethod: null };
  connections.set(account.id, connection);

  try {
    await restoreSessionFiles(account.id);
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
    socket.ev.on("creds.update", (credentials) => {
      void saveCreds(credentials)
        .then(() => persistSessionFiles(account.id))
        .catch((error) => console.error(`No se pudo guardar la sesion de ${account.id}:`, error.message));
    });
    socket.ev.on("contacts.upsert", (contacts) => {
      void persistContacts(account.id, contacts).catch((error) => console.error(`No se pudieron guardar contactos de ${account.id}:`, error.message));
    });
    socket.ev.on("contacts.update", (contacts) => {
      void persistContacts(account.id, contacts).catch((error) => console.error(`No se pudieron actualizar contactos de ${account.id}:`, error.message));
    });
    socket.ev.on("messaging-history.set", ({ contacts }) => {
      void persistContacts(account.id, contacts).catch((error) => console.error(`No se pudieron importar contactos de ${account.id}:`, error.message));
    });
    socket.ev.on("messages.upsert", ({ type, messages }) => {
      if (connection.cancelled || !accounts.some((item) => item.id === account.id)) return;
      if (type !== "notify") return;
      for (const message of messages) {
        if (!message.message || message.key.fromMe) continue;
        const jid = message.key.remoteJid || "desconocido";
        if (message.pushName) void persistContact(account.id, { id: jid, notify: message.pushName });
        void appendMessageLog(account.id, {
          id: message.key.id,
          direction: "inbound",
          jid,
          from: jid.replace("@s.whatsapp.net", ""),
          contactName: message.pushName || null,
          text: extractMessageText(message.message)
        }).catch((error) => console.error(`No se pudo registrar un mensaje de ${account.id}:`, error.message));
      }
    });
    socket.ev.on("connection.update", async ({ connection: stateName, lastDisconnect, qr }) => {
      if (connection.cancelled || !accounts.some((item) => item.id === account.id)) {
        socket.end(undefined);
        return;
      }
      if (qr && connection.linkMethod !== "number") {
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
        if (loggedOut) {
          await clearSessionFiles(account.id);
        }
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
  const accountMatch = requestUrl.pathname.match(/^\/api\/accounts\/([\w-]+)(?:\/(qr|messages|api-key-access|log-access|logs|inbox|pairing-code))?$/);

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
      const account = { id: randomUUID(), name, apiKeyHash: null, apiKeyPrefix: null, createdAt: new Date().toISOString() };
      accounts.push(account);
      await persistAccount(account);
      connectAccount(account);
      sendJson(response, 201, { account: publicAccount(account) });
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
        const contact = (await loadContacts(account.id)).get(recipient);
        await appendMessageLog(account.id, { id: message.key.id, direction: "outbound", jid: recipient, to: recipient.replace("@s.whatsapp.net", ""), contactName: contact?.name || null, text });
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
        sendJson(response, 200, { accountId: account.id, messages: await findMessageLogs(account.id, { ...Object.fromEntries(requestUrl.searchParams), limit }) });
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
        if (connection) connection.linkMethod = "qr";
        sendJson(response, 200, { qr: connection?.qr || null, status: connection?.status || "desconectada" });
        return;
      }

      if (request.method === "POST" && action === "pairing-code") {
        const body = await readBody(request);
        const phone = normalizePairingPhone(body.phone);
        if (!phone) {
          sendJson(response, 400, { error: "Indica un numero internacional valido, con codigo de pais." });
          return;
        }
        if (connection?.status === "conectada") {
          sendJson(response, 409, { error: "La cuenta ya esta vinculada." });
          return;
        }
        const activeConnection = await waitForSocket(account);
        activeConnection.linkMethod = "number";
        const code = await activeConnection.socket.requestPairingCode(phone);
        activeConnection.qr = null;
        activeConnection.status = "esperando codigo";
        sendJson(response, 200, { code, expiresIn: 60 });
        return;
      }

      if (request.method === "POST" && action === "api-key-access") {
        await sendVerificationCode(account, apiKeyAccessChallenges, "crear o actualizar tu API key");
        sendJson(response, 200, { status: "codigo_enviado", expiresIn: 600 });
        return;
      }

      if (request.method === "PUT" && action === "api-key-access") {
        const body = await readBody(request);
        if (!verifyCode(account.id, apiKeyAccessChallenges, String(body.code || ""))) {
          sendJson(response, 401, { error: "El codigo expiro o es incorrecto. Solicita uno nuevo." });
          return;
        }
        const apiKey = createApiKey();
        account.apiKeyHash = apiKey.apiKeyHash;
        account.apiKeyPrefix = apiKey.apiKeyPrefix;
        await persistAccount(account);
        sendJson(response, 201, { apiKey: apiKey.apiKey, apiKeyPrefix: apiKey.apiKeyPrefix });
        return;
      }

      if (request.method === "POST" && action === "log-access") {
        await sendVerificationCode(account, logAccessChallenges, "ver el Log cifrado");
        sendJson(response, 200, { status: "codigo_enviado", expiresIn: 600 });
        return;
      }

      if (request.method === "PUT" && action === "log-access") {
        const body = await readBody(request);
        const code = String(body.code || "");
        if (!verifyCode(account.id, logAccessChallenges, code)) {
          sendJson(response, 401, { error: "El codigo expiro o es incorrecto. Solicita uno nuevo." });
          return;
        }
        logAccessChallenges.delete(account.id);
        sendJson(response, 200, { accessToken: createLogAccessToken(account.id), expiresIn: 900 });
        return;
      }

      if (request.method === "GET" && action === "logs") {
        const accessToken = request.headers["x-log-access-token"];
        if (!hasLogAccess(account.id, accessToken)) {
          sendJson(response, 403, { error: "Desbloquea el Log con el codigo enviado a WhatsApp." });
          return;
        }
        sendJson(response, 200, { messages: await findMessageLogs(account.id, Object.fromEntries(requestUrl.searchParams)) });
        return;
      }

      if (request.method === "GET" && action === "inbox") {
        const accessToken = request.headers["x-log-access-token"];
        if (!hasLogAccess(account.id, accessToken)) {
          sendJson(response, 403, { error: "Verifica esta cuenta antes de abrir sus conversaciones." });
          return;
        }
        sendJson(response, 200, await buildInbox(account.id, Object.fromEntries(requestUrl.searchParams)));
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
        const contact = (await loadContacts(account.id)).get(recipient);
        await appendMessageLog(account.id, { id: message.key.id, direction: "outbound", jid: recipient, to: recipient.replace("@s.whatsapp.net", ""), contactName: contact?.name || null, text });
        sendJson(response, 201, { id: message.key.id, status: "enviado" });
        return;
      }

      if (request.method === "DELETE" && !action) {
        if (connection) connection.cancelled = true;
        connection?.socket?.end(undefined);
        connections.delete(accountId);
        contactCache.delete(accountId);
        loadedContactAccounts.delete(accountId);
        accounts = accounts.filter((item) => item.id !== accountId);
        if (database) {
          await database.execute("DELETE FROM wa_accounts WHERE id = ?", [accountId]);
          await database.execute("DELETE FROM wa_message_logs WHERE account_id = ?", [accountId]);
        } else {
          saveAccounts();
        }
        await clearSessionFiles(accountId);
        fs.rmSync(logFileFor(accountId), { force: true });
        sendJson(response, 200, { deleted: true });
        return;
      }
    }

    serveStatic(requestUrl, response);
  } catch (error) {
    sendJson(response, error.statusCode || 500, { error: error instanceof SyntaxError ? "JSON invalido." : error.message || "Error interno." });
  }
});

async function startServer() {
  if (databaseVariablesPresent && !databaseEnabled) {
    throw new Error("La configuracion de MySQL esta incompleta; la aplicacion no usara almacenamiento temporal.");
  }
  await initializeStorage();
  server.listen(port, "0.0.0.0", () => {
    console.log(`Dashboard disponible en http://localhost:${port}${database ? " con MySQL" : " con almacenamiento local"}`);
    accounts.forEach((account) => connectAccount(account));
  });
}

startServer().catch((error) => {
  console.error("No se pudo inicializar el almacenamiento:", error.message);
  process.exit(1);
});
