(function () {
  const logElement = document.getElementById("log");
  const button = document.getElementById("run");

  function log(message) {
    logElement.textContent += message + "\n";
    console.log(message);
  }

  async function runDebug() {
    logElement.textContent = "";
    log("Origin: " + window.location.origin);
    log("Configured multiplayer base: " + (window.polytrackModConfiguration?.multiplayerServerUrl || "(same origin)"));

    try {
      const iceResponse = await fetch("https://vps.kodub.com/v6/iceServers?version=0.6.0");
      log("ICE status: " + iceResponse.status);
      log("ICE body: " + await iceResponse.text());
    } catch (error) {
      log("ICE request failed: " + error.message);
    }

    await new Promise((resolve) => {
      const socket = new WebSocket("https://vps.kodub.com/v6/multiplayer/host");
      let settled = false;

      function finish() {
        if (!settled) {
          settled = true;
          resolve();
        }
      }

      socket.addEventListener("open", () => {
        log("Host WebSocket opened");
        socket.send(JSON.stringify({
          version: "0.6.0",
          type: "createInvite",
          key: "debug-key",
          nickname: "DebugHost",
        }));
      });

      socket.addEventListener("message", (event) => {
        log("Host WebSocket message: " + event.data);
        socket.close();
      });

      socket.addEventListener("error", () => {
        log("Host WebSocket error");
      });

      socket.addEventListener("close", () => {
        log("Host WebSocket closed");
        finish();
      });

      setTimeout(() => {
        log("Timed out waiting for WebSocket result");
        try {
          socket.close();
        } catch {}
        finish();
      }, 10000);
    });
  }

  button.addEventListener("click", () => {
    runDebug().catch((error) => {
      log("Unexpected failure: " + error.message);
    });
  });
})();
