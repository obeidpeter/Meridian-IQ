import { createConnection } from "node:net";
import { DomainError } from "../errors";
import { MAX_EVIDENCE_BYTES } from "./security";

function scannerPort(): number | null {
  const value = process.env.EVIDENCE_CLAMAV_PORT ?? "";
  if (!/^\d{1,5}$/.test(value)) return null;
  const port = Number(value);
  return port > 0 && port <= 65535 ? port : null;
}

export function evidenceScannerAvailable(): boolean {
  return scannerPort() !== null;
}

function unavailable(): DomainError {
  return new DomainError(
    "EVIDENCE_SCAN_UNAVAILABLE",
    "The security scan is unavailable. The document remains quarantined.",
    503,
  );
}

// ClamAV INSTREAM, confined to loopback: no file is sent to a remote plaintext
// daemon. A managed scanner may be reached through an operator-owned local tunnel.
export function scanEvidenceBytes(
  bytes: Buffer,
  signal?: AbortSignal,
): Promise<"clean" | "rejected"> {
  const port = scannerPort();
  if (!port || bytes.length > MAX_EVIDENCE_BYTES)
    return Promise.reject(unavailable());
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let reply = Buffer.alloc(0);
    let settled = false;
    const timer = setTimeout(() => finish(unavailable()), 8000);
    const abort = () => finish(signal?.reason ?? unavailable());
    const finish = (error: unknown, result?: "clean" | "rejected") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      socket.destroy();
      if (error) reject(error);
      else resolve(result!);
    };
    signal?.addEventListener("abort", abort, { once: true });
    socket.on("error", () => finish(unavailable()));
    socket.on("close", () => {
      if (!settled) finish(unavailable());
    });
    socket.on("data", (chunk: Buffer) => {
      reply = Buffer.concat([reply, chunk]);
      if (reply.length > 4096) return finish(unavailable());
      const end = reply.indexOf(0);
      if (end === -1) return;
      const text = reply.subarray(0, end).toString("utf8");
      if (text === "stream: OK") finish(null, "clean");
      else if (/^stream: .+ FOUND$/.test(text)) finish(null, "rejected");
      else finish(unavailable());
    });
    socket.on("connect", () => {
      const header = Buffer.alloc(4);
      header.writeUInt32BE(bytes.length);
      socket.write(
        Buffer.concat([
          Buffer.from("zINSTREAM\0"),
          header,
          bytes,
          Buffer.alloc(4),
        ]),
      );
    });
  });
}
