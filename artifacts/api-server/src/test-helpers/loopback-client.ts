import { randomInt } from "node:crypto";
import { request, type ClientRequest } from "node:http";

const allocatedAddresses = new Set<string>();
const RESPONSE_LIMIT = 1_048_576;

// Linux routes the whole 127/8 block to the loopback interface, so every
// fixture can own a real, distinct source address and the persistent per-IP
// throttles stay enabled without being touched. macOS and Windows configure
// 127.0.0.1 alone (an alias needs root), so there every fixture shares it:
// the client says so through `isolated`, and the few tests that need a
// private per-IP counter skip instead of failing (R116).
export const LOOPBACK_SOURCES_ISOLATED = process.platform === "linux";

// One real TCP source address per fixture/file, stable across its requests.
// Persistent IP throttles stay enabled; no forwarded headers or identity mocks.
export function createLoopbackClient(
  timeoutMs = 10_000,
  { isolatedSources = LOOPBACK_SOURCES_ISOLATED } = {},
) {
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > 60_000
  ) {
    throw new Error("Loopback deadline must be between 1 and 60000 ms");
  }
  let address = "127.0.0.1";
  if (isolatedSources) {
    do {
      address = `127.${randomInt(1, 255)}.${randomInt(0, 256)}.${randomInt(1, 255)}`;
    } while (allocatedAddresses.has(address));
    allocatedAddresses.add(address);
  }
  const active = new Set<ClientRequest>();
  let closed = false;

  return {
    address,
    isolated: isolatedSources,
    async request(
      input: string,
      options: {
        method?: string;
        headers?: Record<string, string>;
        body?: string;
      } = {},
    ): Promise<Response> {
      if (closed) throw new Error("Loopback client is closed");
      const url = new URL(input);
      if (
        url.protocol !== "http:" ||
        url.hostname !== "127.0.0.1" ||
        url.username ||
        url.password
      ) {
        throw new Error(
          "Loopback client requires an uncredentialed http://127.0.0.1 URL",
        );
      }
      return new Promise<Response>((resolve, reject) => {
        const req = request(url, {
          ...options,
          localAddress: address,
          agent: false,
        });
        active.add(req);
        const deadline = setTimeout(
          () => req.destroy(new Error("Loopback request deadline exceeded")),
          timeoutMs,
        );
        deadline.unref();
        req.once("close", () => {
          clearTimeout(deadline);
          active.delete(req);
        });
        req.once("error", reject);
        req.once("response", (res) => {
          void (async () => {
            const chunks: Buffer[] = [];
            let size = 0;
            for await (const chunk of res) {
              const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
              size += bytes.length;
              if (size > RESPONSE_LIMIT)
                throw new Error("Loopback response too large");
              chunks.push(bytes);
            }
            const headers = new Headers();
            for (let i = 0; i < res.rawHeaders.length; i += 2) {
              headers.append(res.rawHeaders[i], res.rawHeaders[i + 1]);
            }
            const status = res.statusCode ?? 500;
            const noBody =
              options.method === "HEAD" || [204, 205, 304].includes(status);
            resolve(
              new Response(noBody ? null : Buffer.concat(chunks), {
                status,
                headers,
              }),
            );
          })().catch((error: unknown) => {
            req.destroy();
            reject(error);
          });
        });
        req.end(options.body);
      });
    },
    close() {
      closed = true;
      for (const req of active)
        req.destroy(new Error("Loopback client closed"));
    },
  };
}
