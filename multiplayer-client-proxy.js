(function () {
  const REMOTE_PREFIX = "https://vps.kodub.com/";
  const sameOriginBase = /^https?:/i.test(window.location.origin) ? window.location.origin : null;
  const configuredBase = window.polytrackModConfiguration?.multiplayerServerUrl;
  const fallbackBase = "http://127.0.0.1:3000";
  const httpBase = (configuredBase || sameOriginBase || fallbackBase).replace(/\/+$/, "");

  function toWebSocketUrl(url) {
    if (!url.startsWith(REMOTE_PREFIX)) {
      return url;
    }

    if (!/\/multiplayer\/(host|join)$/.test(url)) {
      return url;
    }

    const path = url.slice(REMOTE_PREFIX.length).replace(/^\/+/, "");
    const websocketBase = httpBase.replace(/^http:/i, "ws:").replace(/^https:/i, "wss:");
    return websocketBase + "/" + path;
  }

  function toHttpUrl(url) {
    if (!url.startsWith(REMOTE_PREFIX)) {
      return url;
    }

    const path = url.slice(REMOTE_PREFIX.length).replace(/^\/+/, "");
    if (!path.startsWith("iceServers")) {
      return url;
    }

    return httpBase + "/" + path;
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
