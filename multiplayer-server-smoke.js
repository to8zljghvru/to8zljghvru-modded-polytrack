"use strict";

const WebSocket = require("ws");

const baseUrl = process.env.POLYTRACK_SERVER_URL || "http://127.0.0.1:3000";
const websocketBase = baseUrl.replace(/^http:/i, "ws:").replace(/^https:/i, "wss:");

function onceMessage(socket) {
  return new Promise((resolve, reject) => {
    const handleMessage = (data) => {
      cleanup();
      try {
        resolve(JSON.parse(data.toString()));
      } catch (error) {
        reject(error);
      }
    };
    const handleError = (error) => {
      cleanup();
      reject(error);
    };
    const handleClose = () => {
      cleanup();
      reject(new Error("Socket closed before the expected message arrived"));
    };
    const cleanup = () => {
      socket.off("message", handleMessage);
      socket.off("error", handleError);
      socket.off("close", handleClose);
    };
    socket.on("message", handleMessage);
    socket.on("error", handleError);
    socket.on("close", handleClose);
  });
}

function waitForOpen(socket) {
  return new Promise((resolve, reject) => {
    if (socket.readyState === WebSocket.OPEN) {
      resolve();
      return;
    }
    socket.once("open", resolve);
    socket.once("error", reject);
  });
}

async function main() {
  const host = new WebSocket(`${websocketBase}/v6/multiplayer/host`);
  await waitForOpen(host);
  host.send(JSON.stringify({
    version: "0.6.0",
    type: "createInvite",
    key: "host-key",
    nickname: "Host",
  }));

  const createdInvite = await onceMessage(host);
  if (createdInvite.type !== "createInvite" || typeof createdInvite.inviteCode !== "string") {
    throw new Error(`Unexpected host invite response: ${JSON.stringify(createdInvite)}`);
  }

  const join = new WebSocket(`${websocketBase}/v6/multiplayer/join`);
  await waitForOpen(join);
  join.send(JSON.stringify({
    version: "0.6.0",
    inviteCode: createdInvite.inviteCode,
    offer: "{\"type\":\"offer\",\"sdp\":\"fake-offer\"}",
    mods: [],
    isModsVanillaCompatible: true,
    nickname: "Joiner",
    countryCode: "US",
    carStyle: "sport",
  }));

  const joinInvite = await onceMessage(host);
  if (joinInvite.type !== "joinInvite" || typeof joinInvite.session !== "string") {
    throw new Error(`Unexpected join invite message: ${JSON.stringify(joinInvite)}`);
  }

  host.send(JSON.stringify({
    type: "acceptJoin",
    session: joinInvite.session,
    answer: "{\"type\":\"answer\",\"sdp\":\"fake-answer\"}",
    mods: [],
    isModsVanillaCompatible: true,
    clientId: 2,
  }));

  const accepted = await onceMessage(join);
  if (accepted.type !== "acceptJoin" || accepted.clientId !== 2) {
    throw new Error(`Unexpected join acceptance: ${JSON.stringify(accepted)}`);
  }

  join.send(JSON.stringify({
    version: "0.6.0",
    candidate: { candidate: "join-candidate" },
  }));
  const hostCandidate = await onceMessage(host);
  if (hostCandidate.type !== "iceCandidate" || hostCandidate.session !== joinInvite.session) {
    throw new Error(`Unexpected host ICE message: ${JSON.stringify(hostCandidate)}`);
  }

  host.send(JSON.stringify({
    type: "iceCandidate",
    session: joinInvite.session,
    candidate: { candidate: "host-candidate" },
  }));
  const joinCandidate = await onceMessage(join);
  if (joinCandidate.type !== "iceCandidate") {
    throw new Error(`Unexpected join ICE message: ${JSON.stringify(joinCandidate)}`);
  }

  join.close();
  const disconnectNotice = await onceMessage(host);
  if (disconnectNotice.type !== "joinDisconnect" || disconnectNotice.session !== joinInvite.session) {
    throw new Error(`Unexpected disconnect message: ${JSON.stringify(disconnectNotice)}`);
  }

  host.close();

  process.stdout.write(JSON.stringify({
    ok: true,
    inviteCode: createdInvite.inviteCode,
    session: joinInvite.session,
  }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
