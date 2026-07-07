import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

// Register the self-healing root service worker. Its only job is to evict any
// stale root-scoped worker left by the app that previously lived at "/", so the
// portal and its sibling apps never get served a cached wrong shell.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
      /* best-effort self-heal */
    });
  });
}

createRoot(document.getElementById("root")!).render(<App />);
