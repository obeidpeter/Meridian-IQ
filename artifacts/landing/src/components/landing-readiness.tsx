import { useEffect, useState } from "react";
import { RotateCw } from "lucide-react";

export function LandingReadiness() {
  const [state, setState] = useState<"checking" | "operational" | "degraded">(
    "checking",
  );
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 6_000);
    setState("checking");
    void fetch("/api/readyz", {
      signal: controller.signal,
      cache: "no-store",
      headers: { accept: "application/json" },
    })
      .then((response) => {
        if (active)
          setState(
            response.ok &&
              response.headers.get("content-type")?.includes("application/json")
              ? "operational"
              : "degraded",
          );
      })
      .catch(() => {
        if (active) setState("degraded");
      })
      .finally(() => window.clearTimeout(timer));
    return () => {
      active = false;
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [refresh]);
  return (
    <div className="editorial-readiness">
      <p role="status">
        <span className={`editorial-status-dot ${state}`} aria-hidden="true" />
        {state === "checking"
          ? "Checking Valo availability"
          : state === "operational"
            ? "Valo is available"
            : "We could not confirm Valo is available"}
      </p>
      {state === "degraded" && (
        <button
          type="button"
          className="editorial-text-link"
          onClick={() => setRefresh((value) => value + 1)}
        >
          <RotateCw size={16} aria-hidden="true" />
          Try again
        </button>
      )}
    </div>
  );
}
