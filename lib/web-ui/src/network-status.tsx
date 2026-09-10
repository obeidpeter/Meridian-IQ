import { useCallback, useEffect, useRef, useState } from "react";
import { CloudOff, Gauge, RefreshCw, Wifi } from "lucide-react";
import { trackUsabilityEvent } from "./usability";

interface NetworkInformationLike extends EventTarget {
  effectiveType?: string;
  saveData?: boolean;
}

function connection(): NetworkInformationLike | null {
  if (typeof navigator === "undefined") return null;
  return (
    (navigator as Navigator & { connection?: NetworkInformationLike })
      .connection ?? null
  );
}

function isConstrained(): boolean {
  const current = connection();
  return Boolean(
    current?.saveData ||
    current?.effectiveType === "slow-2g" ||
    current?.effectiveType === "2g",
  );
}

export function NetworkStatus() {
  const [online, setOnline] = useState(() =>
    typeof navigator === "undefined" ? true : navigator.onLine,
  );
  const [constrained, setConstrained] = useState(isConstrained);
  const [checking, setChecking] = useState(false);
  const [restored, setRestored] = useState(false);
  const previousOnline = useRef(online);

  const readNetwork = useCallback(() => {
    setOnline(navigator.onLine);
    setConstrained(isConstrained());
  }, []);

  useEffect(() => {
    const current = connection();
    window.addEventListener("online", readNetwork);
    window.addEventListener("offline", readNetwork);
    current?.addEventListener("change", readNetwork);
    return () => {
      window.removeEventListener("online", readNetwork);
      window.removeEventListener("offline", readNetwork);
      current?.removeEventListener("change", readNetwork);
    };
  }, [readNetwork]);

  useEffect(() => {
    let timer: number | null = null;
    if (previousOnline.current !== online) {
      if (!online) {
        setRestored(false);
        trackUsabilityEvent("offline_detected", "app_shell");
      } else {
        setRestored(true);
        trackUsabilityEvent("online_restored", "app_shell");
        timer = window.setTimeout(() => setRestored(false), 4_000);
      }
      previousOnline.current = online;
    }
    return () => {
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [online]);

  const check = async () => {
    setChecking(true);
    try {
      const response = await fetch("/api/healthz", {
        cache: "no-store",
        credentials: "same-origin",
      });
      if (response.ok) setOnline(true);
    } catch {
      setOnline(false);
    } finally {
      setChecking(false);
    }
  };

  if (online && !constrained && !restored) return null;
  const tone = !online ? "offline" : constrained ? "constrained" : "restored";
  return (
    <div
      className="mi-network-status"
      data-tone={tone}
      role="status"
      aria-live="polite"
    >
      <span className="mi-network-status__icon" aria-hidden="true">
        {!online ? <CloudOff /> : constrained ? <Gauge /> : <Wifi />}
      </span>
      <span className="mi-network-status__copy">
        <strong>
          {!online
            ? "You’re offline"
            : constrained
              ? "Low-bandwidth connection"
              : "Connection restored"}
        </strong>
        <small>
          {!online
            ? "Saved drafts remain on this device. Reconnect before submitting or changing records."
            : constrained
              ? "Large uploads may take longer. Activity keeps an outcome record so retries can be verified."
              : "Live records can be refreshed again."}
        </small>
      </span>
      {!online ? (
        <button type="button" onClick={check} disabled={checking}>
          <RefreshCw
            className={checking ? "is-spinning" : undefined}
            aria-hidden="true"
          />
          {checking ? "Checking" : "Check again"}
        </button>
      ) : null}
    </div>
  );
}
