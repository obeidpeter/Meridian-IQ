import assert from "node:assert/strict";
import { createServer, type Socket } from "node:net";
import { makeEvidencePdf } from "./pdf-test-fixtures";

// Structurally valid synthetic bytes, not an OCR fixture or a malware sample.
export const TEST_EVIDENCE_PDF = makeEvidencePdf();
export const TEST_EVIDENCE_KEY = Buffer.alloc(32, 0x42).toString("hex");

export async function withEvidenceEnvironment<T>(
  values: Record<string, string | undefined>,
  run: () => T | Promise<T>,
): Promise<T> {
  const previous = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]]),
  );
  const assign = (env: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  assign(values);
  try {
    return await run();
  } finally {
    assign(previous);
  }
}

type ScanReply = string | Buffer | null;

/** Exercise the real INSTREAM transport; never replace a production scanner hook. */
export async function withMockClamAv<T>(
  reply: (bytes: Buffer) => ScanReply | Promise<ScanReply>,
  run: (scans: Buffer[]) => Promise<T>,
): Promise<T> {
  const scans: Buffer[] = [];
  const sockets = new Set<Socket>();
  const failures: unknown[] = [];
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let pending = Buffer.alloc(0);
    let handled = false;
    socket.on("data", (chunk: Buffer) => {
      if (handled) return;
      pending = Buffer.concat([pending, chunk]);
      if (pending.length < 14) return;
      const size = pending.readUInt32BE(10);
      if (pending.length < 18 + size) return;
      handled = true;
      void (async () => {
        assert.equal(pending.subarray(0, 10).toString(), "zINSTREAM\0");
        assert.equal(pending.readUInt32BE(14 + size), 0);
        assert.equal(pending.length, 18 + size);
        const bytes = pending.subarray(14, 14 + size);
        scans.push(bytes);
        const response = await reply(bytes);
        if (response !== null) socket.end(response);
      })().catch((error: unknown) => {
        failures.push(error);
        socket.destroy();
      });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const result = await withEvidenceEnvironment(
      { EVIDENCE_CLAMAV_PORT: String(address.port) },
      () => run(scans),
    );
    assert.deepEqual(failures, []);
    return result;
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}
