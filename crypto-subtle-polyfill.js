(function (global) {
  const cryptoObject = global.crypto || global.msCrypto;
  const sha256Api = global.sha256;

  if (!cryptoObject || !sha256Api) {
    return;
  }

  if (!cryptoObject.subtle) {
    cryptoObject.subtle = {};
  }

  if (typeof cryptoObject.subtle.digest === "function") {
    return;
  }

  function normalizeAlgorithm(algorithm) {
    if (typeof algorithm === "string") {
      return algorithm.toUpperCase();
    }

    if (algorithm && typeof algorithm.name === "string") {
      return algorithm.name.toUpperCase();
    }

    return "";
  }

  function toUint8Array(data) {
    if (data instanceof ArrayBuffer) {
      return new Uint8Array(data);
    }

    if (ArrayBuffer.isView(data)) {
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }

    throw new TypeError("Expected ArrayBuffer or typed array input");
  }

  cryptoObject.subtle.digest = function digest(algorithm, data) {
    const normalized = normalizeAlgorithm(algorithm);
    const bytes = toUint8Array(data);

    if (normalized === "SHA-256") {
      return Promise.resolve(sha256Api.arrayBuffer(bytes));
    }

    if (normalized === "SHA-224" && sha256Api.sha224 && typeof sha256Api.sha224.arrayBuffer === "function") {
      return Promise.resolve(sha256Api.sha224.arrayBuffer(bytes));
    }

    return Promise.reject(new Error("Unsupported digest algorithm: " + normalized));
  };
})(window);
