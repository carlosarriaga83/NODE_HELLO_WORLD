const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const makeWASocket = require("@whiskeysockets/baileys").default;
const { DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = require("@whiskeysockets/baileys");
const QRCode = require("qrcode");

const port = Number.parseInt(process.env.PORT, 10) || 3000;
const publicDirectory = path.join(__dirname, "public");
const dataDirectory = path.join(__dirname, "data");
const sessionsDirectory = path.join(dataDirectory, "sessions");
const accountsFile = path.join(dataDirectory, "accounts.json");
const connections = new Map();
const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml"
};

fs.mkdirSync(sessionsDirectory, { recursive: true });

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
    createdAt: account.createdAt
  };
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

  const connection = { status: "conectando", qr: null, phone: null, isConnecting: true, socket: null };
  connections.set(account.id, connection);

  try {
    const { state, saveCreds } = await useMultiFileAuthState(path.join(sessionsDirectory, account.id));
    const { version } = await fetchLatestBaileysVersion();
    const socket = makeWASocket({
      auth: state,
      version,
      printQRInTerminal: false,
      syncFullHistory: false,
      markOnlineOnConnect: false
    });

    connection.socket = socket;
    socket.ev.on("creds.update", saveCreds);
    socket.ev.on("connection.update", async ({ connection: stateName, lastDisconnect, qr }) => {
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
        if (!loggedOut) {
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
  const accountMatch = requestUrl.pathname.match(/^\/api\/accounts\/([\w-]+)(?:\/(qr|messages))?$/);

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
      const account = { id: randomUUID(), name, createdAt: new Date().toISOString() };
      accounts.push(account);
      saveAccounts();
      connectAccount(account);
      sendJson(response, 201, { account: publicAccount(account) });
      return;
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
        sendJson(response, 201, { id: message.key.id, status: "enviado" });
        return;
      }

      if (request.method === "DELETE" && !action) {
        connection?.socket?.end(undefined);
        connections.delete(accountId);
        accounts = accounts.filter((item) => item.id !== accountId);
        saveAccounts();
        fs.rmSync(path.join(sessionsDirectory, accountId), { recursive: true, force: true });
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
