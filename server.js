"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const HOST = process.env.POLYTRACK_HOST || "0.0.0.0";
const PORT = Number.parseInt(process.env.PORT || process.env.POLYTRACK_PORT || "3000", 10);
const ROOT_DIR = __dirname;
const DEFAULT_MAX_AGE_MS = 10 * 60 * 1000;
const ICE_CACHE_TTL_MS = Number.parseInt(process.env.POLYTRACK_ICE_CACHE_TTL_MS || "300000", 10);
const DEFAULT_ICE_SERVERS = [{ urls: ["stun:stun.l.google.com:19302"] }];
const METERED_TURN_CREDENTIALS_URL = process.env.METERED_TURN_CREDENTIALS_URL || null;

const CONTENT_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".ico", "image/x-icon"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".ttf", "font/ttf"],
  [".wasm", "application/wasm"],
  [".ogg", "audio/ogg"],
  [".mp3", "audio/mpeg"],
  [".track", "text/plain; charset=utf-8"],
]);

function loadStaticIceServers() {
  if (!process.env.POLYTRACK_ICE_SERVERS) {
    return DEFAULT_ICE_SERVERS;
  }

  try {
    const parsed = JSON.parse(process.env.POLYTRACK_ICE_SERVERS);
    if (!Array.isArray(parsed)) {
      throw new Error("POLYTRACK_ICE_SERVERS must be a JSON array");
    }
    return parsed;
  } catch (error) {
    console.warn("Failed to parse POLYTRACK_ICE_SERVERS, falling back to default STUN server:", error.message);
    return DEFAULT_ICE_SERVERS;
  }
}

const STATIC_ICE_SERVERS = loadStaticIceServers();
let iceServerCache = {
  expiresAt: 0,
  value: STATIC_ICE_SERVERS,
};

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const transport = url.startsWith("https://") ? https : http;
    const request = transport.get(url, (response) => {
      if (response.statusCode == null) {
        reject(new Error("Missing response status code"));
        return;
      }

      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        reject(new Error(`Unexpected status code ${response.statusCode}`));
        return;
      }

      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });

    request.on("error", reject);
    request.setTimeout(10000, () => {
      request.destroy(new Error("Timed out while fetching ICE servers"));
    });
  });
}

async function resolveIceServers() {
  if (!METERED_TURN_CREDENTIALS_URL) {
    return STATIC_ICE_SERVERS;
  }

  if (iceServerCache.expiresAt > Date.now()) {
    return iceServerCache.value;
  }

  try {
    const fetchedIceServers = await fetchJson(METERED_TURN_CREDENTIALS_URL);
    if (!Array.isArray(fetchedIceServers)) {
      throw new Error("TURN credential response was not an array");
    }

    iceServerCache = {
      expiresAt: Date.now() + ICE_CACHE_TTL_MS,
      value: fetchedIceServers,
    };
    return fetchedIceServers;
  } catch (error) {
    console.warn("Failed to fetch TURN credentials, falling back to static ICE servers:", error.message);
    return STATIC_ICE_SERVERS;
  }
}

function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
  });
  response.end(body);
}

function sendText(response, statusCode, body) {
  response.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
  });
  response.end(body);
}

function resolveFilePath(requestPath) {
  const normalizedPath = requestPath === "/" ? "/index.html" : requestPath;
  const decodedPath = decodeURIComponent(normalizedPath);
  const absolutePath = path.resolve(ROOT_DIR, "." + decodedPath);
  if (!absolutePath.startsWith(ROOT_DIR)) {
    return null;
  }
  return absolutePath;
}

function randomCode(length) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let output = "";
  const bytes = crypto.randomBytes(length);
  for (let index = 0; index < length; index += 1) {
    output += alphabet[bytes[index] % alphabet.length];
  }
  return output;
}

function randomHex(length) {
  return crypto.randomBytes(Math.ceil(length / 2)).toString("hex").slice(0, length);
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function websocketJson(socket, payload) {
  if (socket.readyState === 1) {
    socket.send(JSON.stringify(payload));
  }
}

function normalizeApiPath(pathname) {
  const normalized = pathname.replace(/\/+/g, "/");
  return normalized.startsWith("/v6/") ? normalized.slice(3) : normalized;
}

const invites = new Map();
const hostSocketToInviteCode = new WeakMap();
const joinSocketToSession = new WeakMap();

function createInviteRecord(hostSocket, message) {
  const inviteCode = randomCode(6);
  const key = typeof message.key === "string" && message.key.length > 0 ? message.key : randomHex(16);
  const invite = {
    inviteCode,
    key,
    hostSocket,
    hostNickname: typeof message.nickname === "string" ? message.nickname : null,
    createdAt: Date.now(),
    timeoutMilliseconds: DEFAULT_MAX_AGE_MS,
    pendingJoins: new Map(),
  };
  invites.set(inviteCode, invite);
  hostSocketToInviteCode.set(hostSocket, inviteCode);
  return invite;
}

function isInviteExpired(invite) {
  return Date.now() - invite.createdAt >= invite.timeoutMilliseconds;
}

function destroyInvite(inviteCode, closeReason) {
  const invite = invites.get(inviteCode);
  if (!invite) {
    return;
  }

  invites.delete(inviteCode);
  for (const session of invite.pendingJoins.values()) {
    joinSocketToSession.delete(session.joinSocket);
    if (closeReason) {
      websocketJson(session.joinSocket, closeReason);
    }
    if (session.joinSocket.readyState === session.joinSocket.OPEN || session.joinSocket.readyState === session.joinSocket.CONNECTING) {
      session.joinSocket.close();
    }
  }
  invite.pendingJoins.clear();
}

function findInviteByHostSocket(hostSocket) {
  const inviteCode = hostSocketToInviteCode.get(hostSocket);
  return inviteCode ? invites.get(inviteCode) || null : null;
}

function findSessionForJoinSocket(joinSocket) {
  const sessionId = joinSocketToSession.get(joinSocket);
  if (!sessionId) {
    return null;
  }

  for (const invite of invites.values()) {
    const session = invite.pendingJoins.get(sessionId);
    if (session && session.joinSocket === joinSocket) {
      return { invite, session };
    }
  }

  return null;
}

function cleanupJoinSession(invite, sessionId, notifyHost) {
  const session = invite.pendingJoins.get(sessionId);
  if (!session) {
    return;
  }

  invite.pendingJoins.delete(sessionId);
  joinSocketToSession.delete(session.joinSocket);

  if (notifyHost && invite.hostSocket.readyState === invite.hostSocket.OPEN) {
    websocketJson(invite.hostSocket, {
      type: "joinDisconnect",
      session: sessionId,
    });
  }
}

function handleHostMessage(hostSocket, rawMessage) {
  const invite = findInviteByHostSocket(hostSocket);
  const message = safeJsonParse(rawMessage);

  if (!message || typeof message !== "object" || typeof message.type !== "string") {
    hostSocket.close();
    return;
  }

  if (message.type === "createInvite") {
    if (invite) {
      websocketJson(hostSocket, { type: "error", error: "InviteAlreadyExists" });
      return;
    }

    const createdInvite = createInviteRecord(hostSocket, message);
    websocketJson(hostSocket, {
      type: "createInvite",
      inviteCode: createdInvite.inviteCode,
      key: createdInvite.key,
      timeoutMilliseconds: createdInvite.timeoutMilliseconds,
      censoredNickname: createdInvite.hostNickname,
    });
    return;
  }

  if (!invite) {
    websocketJson(hostSocket, { type: "error", error: "UnknownInvite" });
    return;
  }

  const sessionId = typeof message.session === "string" ? message.session : null;
  const session = sessionId ? invite.pendingJoins.get(sessionId) || null : null;

  if (message.type === "acceptJoin") {
    if (!session || typeof message.answer !== "string" || !Array.isArray(message.mods) || typeof message.isModsVanillaCompatible !== "boolean" || !Number.isSafeInteger(message.clientId) || message.clientId < 1) {
      hostSocket.close();
      return;
    }

    session.accepted = true;
    websocketJson(session.joinSocket, {
      type: "acceptJoin",
      answer: message.answer,
      mods: message.mods,
      isModsVanillaCompatible: message.isModsVanillaCompatible,
      clientId: message.clientId,
    });
    return;
  }

  if (message.type === "declineJoin") {
    if (!session || typeof message.reason !== "string") {
      hostSocket.close();
      return;
    }

    websocketJson(session.joinSocket, {
      type: "declineJoin",
      reason: message.reason,
    });
    cleanupJoinSession(invite, sessionId, false);
    if (session.joinSocket.readyState === session.joinSocket.OPEN) {
      session.joinSocket.close();
    }
    return;
  }

  if (message.type === "iceCandidate") {
    if (!session || (!("candidate" in message))) {
      hostSocket.close();
      return;
    }

    websocketJson(session.joinSocket, {
      type: "iceCandidate",
      candidate: message.candidate ?? null,
    });
    return;
  }

  hostSocket.close();
}

async function handleJoinInit(joinSocket, rawMessage) {
  const message = safeJsonParse(rawMessage);
  if (!message || typeof message !== "object") {
    joinSocket.close();
    return;
  }

  const inviteCode = typeof message.inviteCode === "string" ? message.inviteCode.trim().toUpperCase() : "";
  const invite = invites.get(inviteCode);
  if (!invite || isInviteExpired(invite)) {
    if (invite) {
      destroyInvite(inviteCode, { type: "error", error: "ExpiredInvite" });
    }
    websocketJson(joinSocket, { type: "error", error: "ExpiredInvite" });
    joinSocket.close();
    return;
  }

  if (typeof message.offer !== "string" || !Array.isArray(message.mods) || typeof message.isModsVanillaCompatible !== "boolean" || typeof message.nickname !== "string" || (message.countryCode !== null && typeof message.countryCode !== "string") || typeof message.carStyle !== "string") {
    joinSocket.close();
    return;
  }

  const sessionId = randomHex(24);
  const session = {
    id: sessionId,
    joinSocket,
    accepted: false,
  };
  invite.pendingJoins.set(sessionId, session);
  joinSocketToSession.set(joinSocket, sessionId);
  const iceServers = await resolveIceServers();

  websocketJson(invite.hostSocket, {
    type: "joinInvite",
    session: sessionId,
    offer: message.offer,
    mods: message.mods,
    isModsVanillaCompatible: message.isModsVanillaCompatible,
    nickname: message.nickname,
    countryCode: message.countryCode ?? null,
    carStyle: message.carStyle,
    iceServers,
  });
}

async function handleJoinMessage(joinSocket, rawMessage) {
  const boundSession = findSessionForJoinSocket(joinSocket);
  if (!boundSession) {
    await handleJoinInit(joinSocket, rawMessage);
    return;
  }

  const message = safeJsonParse(rawMessage);
  if (!message || typeof message !== "object" || !("candidate" in message)) {
    joinSocket.close();
    return;
  }

  websocketJson(boundSession.invite.hostSocket, {
    type: "iceCandidate",
    session: boundSession.session.id,
    candidate: message.candidate ?? null,
  });
}

const server = http.createServer(async (request, response) => {
  const requestUrl = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  const apiPath = normalizeApiPath(requestUrl.pathname);

  if (request.method === "GET" && apiPath === "/healthz") {
    response.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end("ok");
    return;
  }

  if (request.method === "GET" && apiPath === "/health") {
    sendJson(response, 200, {
      ok: true,
      invites: invites.size,
    });
    return;
  }

  if (request.method === "GET" && apiPath === "/iceServers") {
    sendJson(response, 200, await resolveIceServers());
    return;
  }

  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    response.end();
    return;
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    sendText(response, 405, "Method Not Allowed");
    return;
  }

  const filePath = resolveFilePath(requestUrl.pathname);
  if (!filePath) {
    sendText(response, 403, "Forbidden");
    return;
  }

  fs.stat(filePath, (statError, stats) => {
    if (statError || !stats.isFile()) {
      sendText(response, 404, "Not Found");
      return;
    }

    const extension = path.extname(filePath).toLowerCase();
    const contentType = CONTENT_TYPES.get(extension) || "application/octet-stream";
    response.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": stats.size,
      "Cache-Control": extension === ".html" || extension === ".js" ? "no-cache" : "public, max-age=3600",
    });

    if (request.method === "HEAD") {
      response.end();
      return;
    }

    fs.createReadStream(filePath).pipe(response);
  });
});

const hostWss = new WebSocketServer({ noServer: true });
const joinWss = new WebSocketServer({ noServer: true });

hostWss.on("connection", (socket) => {
  socket.on("message", (buffer) => handleHostMessage(socket, buffer.toString()));
  socket.on("close", () => {
    const invite = findInviteByHostSocket(socket);
    if (invite) {
      destroyInvite(invite.inviteCode, { type: "error", error: "ExpiredInvite" });
    }
  });
});

joinWss.on("connection", (socket) => {
  socket.on("message", (buffer) => {
    handleJoinMessage(socket, buffer.toString()).catch((error) => {
      console.error("Join socket handling failed:", error);
      socket.close();
    });
  });
  socket.on("close", () => {
    const boundSession = findSessionForJoinSocket(socket);
    if (boundSession) {
      cleanupJoinSession(boundSession.invite, boundSession.session.id, true);
    }
  });
});

server.on("upgrade", (request, socket, head) => {
  const requestUrl = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  const apiPath = normalizeApiPath(requestUrl.pathname);
  if (apiPath === "/multiplayer/host") {
    hostWss.handleUpgrade(request, socket, head, (ws) => hostWss.emit("connection", ws, request));
    return;
  }

  if (apiPath === "/multiplayer/join") {
    joinWss.handleUpgrade(request, socket, head, (ws) => joinWss.emit("connection", ws, request));
    return;
  }

  socket.destroy();
});

server.listen(PORT, HOST, () => {
  console.log(`PolyTrack multiplayer server listening on http://${HOST}:${PORT}`);
  if (METERED_TURN_CREDENTIALS_URL) {
    console.log("ICE servers: dynamic TURN credentials via METERED_TURN_CREDENTIALS_URL");
  } else {
    console.log("ICE servers:", JSON.stringify(STATIC_ICE_SERVERS));
  }
});
