/**
 * Max Estates chat widget embed snippet.
 *
 * Paste this on maxestates.in (theme footer, or a "Insert Headers and
 * Footers" / WPCode snippet) — for example:
 *
 *   <script src="https://YOUR-VERCEL-APP.vercel.app/embed.js" async></script>
 *
 * It injects a small iframe pointed at /widget on this app and resizes it
 * between a closed "bubble" size and an open chat-panel size based on
 * postMessage events sent by the widget itself. No other setup is needed on
 * the WordPress side.
 */
(function () {
  if (window.__maxEstatesChatEmbedded) return;
  window.__maxEstatesChatEmbedded = true;

  var currentScript = document.currentScript;
  var origin = currentScript ? new URL(currentScript.src).origin : "";
  if (!origin) {
    console.error("[max-estates-chat] Could not determine widget origin from script src.");
    return;
  }

  var CLOSED = { width: "76px", height: "76px", bottom: "16px", right: "16px", borderRadius: "9999px" };
  var OPEN_DESKTOP = { width: "400px", height: "600px", bottom: "24px", right: "24px", borderRadius: "16px" };
  var OPEN_MOBILE = { width: "100vw", height: "100dvh", bottom: "0px", right: "0px", borderRadius: "0px" };

  var iframe = document.createElement("iframe");
  iframe.src = origin + "/widget";
  iframe.title = "Max Estates Assistant";
  iframe.setAttribute("aria-label", "Max Estates Assistant chat widget");

  Object.assign(iframe.style, {
    position: "fixed",
    border: "none",
    zIndex: "2147483000",
    overflow: "hidden",
    background: "transparent",
    colorScheme: "light",
    transition: "width 0.2s ease, height 0.2s ease, border-radius 0.2s ease",
  });
  applySize(CLOSED);

  function applySize(size) {
    iframe.style.width = size.width;
    iframe.style.height = size.height;
    iframe.style.bottom = size.bottom;
    iframe.style.right = size.right;
    iframe.style.borderRadius = size.borderRadius;
  }

  function mount() {
    document.body.appendChild(iframe);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }

  window.addEventListener("message", function (event) {
    if (event.origin !== origin) return;
    var data = event.data;
    if (!data || data.source !== "max-estates-chat") return;

    if (data.type === "open") {
      applySize(window.innerWidth < 640 ? OPEN_MOBILE : OPEN_DESKTOP);
    } else if (data.type === "close") {
      applySize(CLOSED);
    }
  });
})();
