(function () {
  const REMOTE_HOST = "vps.kodub.com";
  const sameOriginBase = /^https?:/i.test(window.location.origin) ? window.location.origin : null;
  const configuredBase = window.polytrackModConfiguration?.multiplayerServerUrl;
  const fallbackBase = "http://127.0.0.1:3000";
  const httpBase = (configuredBase || sameOriginBase || fallbackBase).replace(/\/+$/, "");

  function extractRemotePath(url) {
    if (typeof url !== "string") {
      return null;
    }

    try {
      const parsed = new URL(url, window.location.href);
      if (parsed.hostname !== REMOTE_HOST) {
        return null;
      }
      return parsed.pathname.replace(/^\/+/, "") + parsed.search + parsed.hash;
    } catch {
      return null;
    }
  }

  function toWebSocketUrl(url) {
    const remotePath = extractRemotePath(url);
    if (!remotePath) {
      return url;
    }

    if (!/(^|\/)multiplayer\/(host|join)$/.test(remotePath.replace(/[?#].*$/, ""))) {
      return url;
    }

    const websocketBase = httpBase.replace(/^http:/i, "ws:").replace(/^https:/i, "wss:");
    return websocketBase + "/" + remotePath;
  }

  function toHttpUrl(url) {
    const remotePath = extractRemotePath(url);
    if (!remotePath) {
      return url;
    }

    if (!remotePath.startsWith("iceServers") && !remotePath.startsWith("v6/iceServers")) {
      return url;
    }

    return httpBase + "/" + remotePath;
  }

  const NativeWebSocket = window.WebSocket;
  window.WebSocket = function WebSocketProxy(url, protocols) {
    const rewrittenUrl = typeof url === "string" ? toWebSocketUrl(url) : url;
    return protocols === undefined
      ? new NativeWebSocket(rewrittenUrl)
      : new NativeWebSocket(rewrittenUrl, protocols);
  };
  window.WebSocket.prototype = NativeWebSocket.prototype;
  Object.setPrototypeOf(window.WebSocket, NativeWebSocket);

  const nativeXhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function openProxy(method, url) {
    const rewrittenUrl = typeof url === "string" ? toHttpUrl(url) : url;
    return nativeXhrOpen.apply(this, [method, rewrittenUrl, ...Array.prototype.slice.call(arguments, 2)]);
  };

  if (typeof window.fetch === "function") {
    const nativeFetch = window.fetch.bind(window);
    window.fetch = function fetchProxy(input, init) {
      if (typeof input === "string") {
        return nativeFetch(toHttpUrl(input), init);
      }

      if (input instanceof Request) {
        const rewrittenUrl = toHttpUrl(input.url);
        if (rewrittenUrl !== input.url) {
          input = new Request(rewrittenUrl, input);
        }
      }

      return nativeFetch(input, init);
    };
  }
})();
