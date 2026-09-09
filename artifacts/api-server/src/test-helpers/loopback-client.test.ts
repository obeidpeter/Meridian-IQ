import assert from "node:assert/strict";
import { createServer, type RequestListener } from "node:http";
import { test, type TestContext } from "node:test";
import {
  LOOPBACK_SOURCES_ISOLATED,
  createLoopbackClient,
} from "./loopback-client.ts";

async function serve(t: TestContext, handler: RequestListener) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

test(
  "fixture sources are distinct real TCP addresses, stable across requests, with intact cookies and headers",
  {
    skip:
      !LOOPBACK_SOURCES_ISOLATED &&
      "distinct loopback sources need Linux's 127/8 route",
  },
  async (t) => {
    const base = await serve(t, (req, res) => {
      res.setHeader("set-cookie", [
        "session=one; HttpOnly",
        "other=two; HttpOnly",
      ]);
      res.end(
        JSON.stringify({
          ip: req.socket.remoteAddress,
          forwarded: req.headers["x-forwarded-for"] ?? null,
          csrf: req.headers["x-valo-csrf"],
        }),
      );
    });
    const first = createLoopbackClient();
    const second = createLoopbackClient();
    t.after(() => {
      first.close();
      second.close();
    });
    assert.notEqual(first.address, second.address);
    for (const client of [first, second, first]) {
      const response = await client.request(base, {
        headers: { "x-valo-csrf": "1" },
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        ip: client.address,
        forwarded: null,
        csrf: "1",
      });
      assert.deepEqual(response.headers.getSetCookie(), [
        "session=one; HttpOnly",
        "other=two; HttpOnly",
      ]);
    }
  },
);

test("fixture requests preserve JSON bytes and bodyless responses", async (t) => {
  const body = JSON.stringify({ consent: true });
  const base = await serve(t, (req, res) => {
    let received = "";
    req.on("data", (chunk: Buffer) => {
      received += chunk.toString();
    });
    req.on("end", () => {
      assert.equal(received, body);
      assert.equal(req.headers["content-type"], "application/json");
      res.writeHead(204);
      res.end();
    });
  });
  const client = createLoopbackClient();
  t.after(() => client.close());
  const response = await client.request(base, {
    method: "POST",
    body,
    headers: { "content-type": "application/json" },
  });
  assert.equal(response.status, 204);
  assert.equal(await response.text(), "");
});

test("fixture client rejects non-loopback URLs without connecting", async () => {
  for (const timeout of [0, -1, Infinity, NaN, 60_001]) {
    assert.throws(() => createLoopbackClient(timeout), /deadline must be/);
  }
  const client = createLoopbackClient();
  try {
    for (const url of [
      "https://127.0.0.1",
      "http://example.test",
      "http://user:password@127.0.0.1",
    ]) {
      await assert.rejects(client.request(url), /requires an uncredentialed/);
    }
  } finally {
    client.close();
  }
});

test(
  "fixture deadlines and close release stalled requests",
  { timeout: 5_000 },
  async (t) => {
    let arrived!: () => void;
    const arrival = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    let requests = 0;
    const base = await serve(t, () => {
      if (++requests === 2) arrived();
    });
    const timed = createLoopbackClient(100);
    const closed = createLoopbackClient();
    t.after(() => {
      timed.close();
      closed.close();
    });
    await assert.rejects(timed.request(base), /deadline exceeded/);
    const pending = assert.rejects(closed.request(base), /client closed/);
    await arrival;
    closed.close();
    await pending;
    await assert.rejects(closed.request(base), /client is closed/);
  },
);

test("fixture responses cannot buffer unbounded data", async (t) => {
  const base = await serve(t, (_req, res) => res.end(Buffer.alloc(1_048_577)));
  const client = createLoopbackClient();
  t.after(() => client.close());
  await assert.rejects(client.request(base), /response too large/);
});

test("without an isolated 127/8 route every fixture shares 127.0.0.1 and says so (R116)", async (t) => {
  const base = await serve(t, (req, res) => {
    res.end(JSON.stringify({ ip: req.socket.remoteAddress }));
  });
  const first = createLoopbackClient(10_000, { isolatedSources: false });
  const second = createLoopbackClient(10_000, { isolatedSources: false });
  t.after(() => {
    first.close();
    second.close();
  });
  assert.equal(first.address, "127.0.0.1");
  assert.equal(second.address, "127.0.0.1");
  assert.equal(first.isolated, false);
  for (const client of [first, second]) {
    const response = await client.request(base);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ip: "127.0.0.1" });
  }
  assert.equal(createLoopbackClient().isolated, LOOPBACK_SOURCES_ISOLATED);
});
