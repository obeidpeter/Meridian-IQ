#!/usr/bin/env node
/* global document, innerWidth, innerHeight, Image */
// Offline, reproducible asset CLI: node scripts/branding-assets.mjs [--check].
// Override Chromium with PLAYWRIGHT_EXECUTABLE_PATH when needed.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
const { chromium } = createRequire(new URL("./package.json", import.meta.url))(
  "playwright",
);

const root = path.resolve(import.meta.dirname, "..");
const mobileRequire = createRequire(
  path.join(root, "artifacts/mobile/package.json"),
);
const webRequire = createRequire(
  path.join(root, "lib/web-config/package.json"),
);
const MARK =
  "M2.8 5H9.6L15 15.8L11.6 22.6Z M22.4 3H29.2L16.8 27.8C16.4 28.6 15.2 28.6 14.8 27.8L12.8 23.8Z";
const OLIVE = "#536149";
const INK = "#252a24";
const WHITE = "#ffffff";
const webApps = [
  "landing",
  "console",
  "sme-compliance",
  "buyer-portal",
  "penalty-calculator",
];
const brandDir = "artifacts/landing/public/brand";
const illustrationLabel =
  "Illustrative preview | Synthetic data | Not a live account";
const iconDir = "artifacts/mobile/assets/images";
const icons = [
  {
    name: "icon.png",
    size: 1024,
    markSize: 640,
    color: WHITE,
    background: OLIVE,
  },
  {
    name: "adaptive-icon.png",
    size: 1024,
    markSize: 640,
    color: WHITE,
    background: "transparent",
  },
  {
    name: "splash-icon.png",
    size: 1024,
    markSize: 448,
    color: OLIVE,
    background: "transparent",
  },
  {
    name: "notification-icon.png",
    size: 96,
    markSize: 80,
    color: WHITE,
    background: "transparent",
  },
];
const social = [
  {
    app: "landing",
    title: "Nigerian invoicing & compliance",
    subtitle: "Invoices. Evidence. One workspace.",
  },
  {
    app: "sme-compliance",
    title: "Business workspace",
    subtitle: "Invoicing, deadlines and reconciliation.",
  },
  {
    app: "buyer-portal",
    title: "Buyer portal",
    subtitle: "Supplier invoices and payment confirmations.",
  },
  {
    app: "penalty-calculator",
    title: "Penalty estimator",
    subtitle: "Illustrative estimates. Not tax advice.",
  },
];

function mark(size, color) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 32 32" fill="${color}" xmlns="http://www.w3.org/2000/svg"><path d="${MARK}"/></svg>`;
}

async function generateVectors(outputs) {
  for (const file of [
    "lib/web-ui/src/valo-mark.tsx",
    "artifacts/mobile/components/valo-mark.tsx",
  ]) {
    assert.ok(
      (await readFile(path.join(root, file), "utf8")).includes(`d="${MARK}"`),
      `${file}: shared ribbon geometry`,
    );
  }
  const favicon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="${OLIVE}"/><path d="${MARK}" transform="translate(3 3) scale(.8125)" fill="#fff"/></svg>\n`;
  for (const app of webApps)
    outputs.set(`artifacts/${app}/public/favicon.svg`, Buffer.from(favicon));

  // Outline the installed OFL-licensed Inter face: exported logos need no fonts.
  const apiRequire = createRequire(
    path.join(root, "artifacts/api-server/package.json"),
  );
  const fontkit = createRequire(apiRequire.resolve("pdfkit/package.json"))(
    "fontkit",
  );
  const font = fontkit.create(
    await readFile(
      mobileRequire.resolve(
        "@expo-google-fonts/inter/600SemiBold/Inter_600SemiBold.ttf",
      ),
    ),
  );
  const run = font.layout("Valo", { kern: false });
  let advance = 0;
  const letters = run.glyphs
    .map((glyph, index) => {
      const position = run.positions[index];
      const letter = `<path transform="translate(${advance + position.xOffset} ${position.yOffset})" d="${glyph.path.toSVG()}"/>`;
      advance += position.xAdvance;
      return letter;
    })
    .join("");
  const scale = 34 / font.unitsPerEm;
  const width = Math.ceil(43 + advance * scale);
  for (const [name, symbol, type] of [
    ["valo-logo", OLIVE, INK],
    ["valo-logo-white", WHITE, WHITE],
    ["valo-logo-mono", INK, INK],
  ]) {
    outputs.set(
      `${brandDir}/${name}.svg`,
      Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} 36" role="img" aria-labelledby="title"><title id="title">Valo</title><path transform="translate(0 2)" d="${MARK}" fill="${symbol}"/><g fill="${type}" transform="translate(42 29) scale(${scale} ${-scale})">${letters}</g></svg>\n`,
      ),
    );
  }
  outputs.set(
    `${brandDir}/valo-mark.svg`,
    Buffer.from(
      mark(32, OLIVE).replace(
        "><path",
        ' role="img" aria-labelledby="title"><title id="title">Valo</title><path',
      ) + "\n",
    ),
  );
  outputs.set(
    `${brandDir}/Inter-LICENSE.txt`,
    Buffer.from(
      (
        await readFile(
          mobileRequire.resolve("@expo-google-fonts/inter/LICENSE_FONT"),
          "utf8",
        )
      )
        .replaceAll("\r\n", "\n")
        .replace(/[\t ]+$/gm, ""),
    ),
  );
}

async function generateLogoPreviews(page, vectors, outputs) {
  for (const [file, bytes] of vectors) {
    if (!file.startsWith(brandDir) || !file.endsWith(".svg")) continue;
    const svg = bytes.toString("utf8");
    const viewBox = svg.match(/viewBox="0 0 (\d+) (\d+)"/);
    assert.ok(viewBox);
    const width = Number(viewBox[1]) * 10;
    const height = Number(viewBox[2]) * 10;
    await page.setViewportSize({ width, height });
    await page.setContent(
      `<style>html,body{margin:0;background:transparent}svg{display:block;width:100%;height:100%}</style>${svg}`,
    );
    outputs.set(
      file.replace(/\.svg$/, ".png"),
      await page.screenshot({ omitBackground: true }),
    );
  }
}

async function assertRasterMatch(page, actual, expected, file) {
  const difference = await page.evaluate(
    async ({ actual, expected }) => {
      async function pixels(data) {
        const image = new Image();
        image.src = `data:image/png;base64,${data}`;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext("2d");
        context.drawImage(image, 0, 0);
        return {
          width: image.width,
          height: image.height,
          data: context.getImageData(0, 0, image.width, image.height).data,
        };
      }
      const a = await pixels(actual);
      const b = await pixels(expected);
      if (a.width !== b.width || a.height !== b.height) return 1;
      let different = 0;
      for (let i = 0; i < a.data.length; i += 4) {
        if (
          [0, 1, 2, 3].some(
            (channel) =>
              Math.abs(a.data[i + channel] - b.data[i + channel]) > 12,
          )
        )
          different++;
      }
      return different / (a.width * a.height);
    },
    {
      actual: actual.toString("base64"),
      expected: expected.toString("base64"),
    },
  );
  assert.ok(
    difference < 0.002,
    `${file}: raster does not match current ribbon/vector (${difference})`,
  );
}

async function fontCss() {
  const fonts = [
    [400, "400Regular"],
    [600, "600SemiBold"],
    [700, "700Bold"],
  ];
  return (
    await Promise.all(
      fonts.map(async ([weight, folder]) => {
        const bytes = await readFile(
          mobileRequire.resolve(
            `@expo-google-fonts/inter/${folder}/Inter_${folder}.ttf`,
          ),
        );
        return `@font-face{font-family:Inter;src:url(data:font/ttf;base64,${bytes.toString("base64")}) format('truetype');font-weight:${weight};font-display:block;}`;
      }),
    )
  ).join("\n");
}

async function generateIcons(page, outputs) {
  for (const icon of icons) {
    await page.setViewportSize({ width: icon.size, height: icon.size });
    await page.setContent(
      `<style>html,body{margin:0;width:100%;height:100%;background:${icon.background}}body{display:grid;place-items:center}</style>${mark(icon.markSize, icon.color)}`,
    );
    outputs.set(
      `${iconDir}/${icon.name}`,
      await page.screenshot({ omitBackground: true }),
    );
  }
}

async function generateSocial(page, fonts, outputs) {
  await page.setViewportSize({ width: 1200, height: 630 });
  for (const item of social) {
    await page.setContent(`<html lang="en"><head><style>${fonts}
      *{box-sizing:border-box;letter-spacing:0}body{margin:0;font-family:Inter,sans-serif;color:#172126;background:#fff}
      header{height:374px;background:${OLIVE};padding:64px 72px;color:white}
      .brand{display:flex;align-items:center;gap:32px}.brand span{font-size:128px;font-weight:600;line-height:1.1}
      .category{margin:32px 0 0;font-size:24px;font-weight:600;color:#fff}
      main{padding:38px 72px 0}h1{font-size:40px;line-height:1.2;margin:0;font-weight:700}
      p{font-size:24px;line-height:1.5;margin:16px 0 0;color:#52615d}
      footer{position:absolute;bottom:0;left:0;width:100%;height:10px;background:${INK}}
      </style></head><body><header><div class="brand">${mark(148, WHITE)}<span>Valo</span></div>
      <div class="category">NIGERIAN INVOICING &amp; COMPLIANCE</div></header>
      <main><h1>${item.title}</h1><p>${item.subtitle}</p></main><footer></footer></body></html>`);
    await page.evaluate(() => document.fonts.ready);
    assert.equal(
      await page
        .locator("body")
        .innerText()
        .then((t) => /meridian|localhost|502/i.test(t)),
      false,
    );
    assert.equal(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth > innerWidth ||
          document.documentElement.scrollHeight > innerHeight,
      ),
      false,
    );
    outputs.set(
      `artifacts/${item.app}/public/opengraph.jpg`,
      await page.screenshot({ type: "jpeg", quality: 94 }),
    );
  }
}

function fixtureResponses(contractVersion) {
  const clientPartyId = "illustrative-business";
  const emptyBucket = { amount: "0", count: 0 };
  return {
    "/api/me": {
      userId: "illustrative-user",
      role: "client_user",
      fullName: "Demo owner",
      email: "owner@example.invalid",
      clientPartyId,
      workspaceName: "Example business (demo)",
      capabilities: ["invoice.read", "invoice.write"],
      features: [],
      consentCaptured: true,
    },
    "/api/healthz": { status: "ok", contractVersion },
    "/api/notifications": { items: [], unreadCount: 0 },
    "/api/dashboard/summary": {
      clientPartyId,
      totalInvoices: 15,
      pendingCount: 1,
      stampedCount: 12,
      draftCount: 2,
      failedCount: 0,
      cancelledCount: 0,
      unsubmittedCount: 2,
      unsubmittedValue: "150000",
      stampedValue: "2450000",
      atRiskCount: 0,
      upcomingDeadlineCount: 0,
      nextDeadline: null,
      penaltyRisk: "low",
      recentActivity: [
        {
          id: "demo-103",
          label: "Demo invoice INV-0103",
          at: "2026-09-07T09:15:00Z",
          status: "stamped",
        },
        {
          id: "demo-102",
          label: "Demo invoice INV-0102",
          at: "2026-09-07T08:30:00Z",
          status: "stamped",
        },
        {
          id: "demo-101",
          label: "Demo invoice INV-0101",
          at: "2026-09-06T15:00:00Z",
          status: "draft",
        },
      ],
    },
    "/api/dashboard/receivables": {
      asOf: "2026-09-07T10:00:00Z",
      topDebtors: [],
      groups: [
        {
          currency: "NGN",
          outstandingTotal: "320000",
          invoiceCount: 3,
          buckets: {
            current: { amount: "320000", count: 3 },
            days31to60: emptyBucket,
            days61to90: emptyBucket,
            days90plus: emptyBucket,
          },
        },
      ],
    },
    "/api/month-end-close": {
      asOf: "2026-09-07T10:00:00Z",
      items: [],
      attentionCount: 0,
      note: "Illustrative preview",
    },
  };
}

async function generateDashboard(browser, fonts, outputs) {
  const temp = await mkdtemp(path.join(tmpdir(), "valo-branding-"));
  let vite;
  let server;
  let context;
  try {
    const { createServer: createViteServer } = await import(
      pathToFileURL(webRequire.resolve("vite"))
    );
    const { default: react } = await import(
      pathToFileURL(webRequire.resolve("@vitejs/plugin-react"))
    );
    const { default: tailwind } = await import(
      pathToFileURL(webRequire.resolve("@tailwindcss/vite"))
    );
    const version = await readFile(
      path.join(root, "lib/api-client-react/src/generated/version.ts"),
      "utf8",
    );
    const contractVersion = version.match(
      /API_CONTRACT_VERSION\s*=\s*["']([^"']+)/,
    )?.[1];
    assert.ok(contractVersion, "Could not read local API contract version");
    const fixtures = fixtureResponses(contractVersion);
    const unexpected = new Set();
    const appRoot = path.join(root, "artifacts/sme-compliance");
    vite = await createViteServer({
      configFile: false,
      envFile: false,
      root: appRoot,
      base: "/app/",
      cacheDir: path.join(temp, "vite"),
      plugins: [
        react(),
        tailwind(),
        {
          name: "offline-branding-preview",
          transformIndexHtml(html) {
            return html
              .replace(/<link\b[^>]*https:\/\/[^>]*>/g, "")
              .replace("</head>", `<style>${fonts}</style></head>`);
          },
        },
      ],
      resolve: {
        alias: {
          "@": path.join(appRoot, "src"),
          "@assets": path.join(root, "attached_assets"),
        },
        dedupe: ["react", "react-dom"],
      },
      server: { middlewareMode: true, hmr: false, fs: { allow: [root] } },
      logLevel: "warn",
    });
    server = createServer((req, res) => vite.middlewares(req, res));
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const origin = `http://127.0.0.1:${server.address().port}`;
    context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      deviceScaleFactor: 1,
      colorScheme: "light",
      locale: "en-GB",
      timezoneId: "Africa/Lagos",
      serviceWorkers: "block",
    });
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      if (!url.pathname.startsWith("/api/")) return route.continue();
      if (route.request().method() !== "GET" || !(url.pathname in fixtures)) {
        unexpected.add(`${route.request().method()} ${url.pathname}`);
        return route.fulfill({
          status: 501,
          json: { error: "No offline fixture" },
        });
      }
      return route.fulfill({ json: fixtures[url.pathname] });
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.clock.setFixedTime(new Date("2026-09-07T10:00:00Z"));
    await page.goto(`${origin}/app/dashboard`, {
      waitUntil: "networkidle",
      timeout: 120_000,
    });
    assert.deepEqual(
      errors,
      [],
      "Dashboard must render without runtime errors",
    );
    await page
      .getByText("What needs attention", { exact: true })
      .waitFor({ timeout: 30_000 });
    await page.getByText("Demo invoice INV-0103", { exact: true }).waitFor();
    await page.evaluate(() => document.fonts.ready);
    // Reserve the disclosure strip without covering the sidebar's last action.
    await page.addStyleTag({
      content:
        "aside.sticky{height:calc(100vh - 36px);min-height:calc(100vh - 36px)}",
    });
    await page.evaluate((label) => {
      const banner = document.createElement("div");
      banner.id = "branding-preview-disclosure";
      banner.textContent = label;
      banner.style.cssText =
        "position:fixed;bottom:0;left:0;right:0;z-index:99999;height:36px;display:grid;place-items:center;background:#fff;color:#172126;border-top:1px solid #cbd5d2;font:600 14px Inter,sans-serif;letter-spacing:0";
      document.body.appendChild(banner);
    }, illustrationLabel);
    assert.deepEqual(
      errors,
      [],
      "Dashboard must render without runtime errors",
    );
    assert.deepEqual(
      [...unexpected],
      [],
      "Add explicit synthetic fixtures for new API reads",
    );
    assert.match(await page.locator("body").innerText(), /Valo/);
    assert.doesNotMatch(
      await page.locator("body").innerText(),
      /MeridianIQ|Couldn't load|temporarily unavailable/i,
    );
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    outputs.set(
      "artifacts/landing/public/compliance-dashboard.jpg",
      await page.screenshot({
        type: "jpeg",
        quality: 94,
        animations: "disabled",
      }),
    );
  } finally {
    await context?.close();
    await vite?.close();
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    // Only remove the freshly-created, verified asset-generation scratch directory.
    assert.equal(path.dirname(temp), path.resolve(tmpdir()));
    assert.ok(path.basename(temp).startsWith("valo-branding-"));
    await rm(temp, { recursive: true, force: true });
  }
}

async function inspectImage(page, bytes, mime) {
  return page.evaluate(
    async ({ data, mime }) => {
      const image = new Image();
      image.src = `data:${mime};base64,${data}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(image, 0, 0);
      const pixels = ctx.getImageData(0, 0, image.width, image.height).data;
      let visible = 0;
      let white = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i + 3] > 0) visible++;
        if (
          pixels[i] > 245 &&
          pixels[i + 1] > 245 &&
          pixels[i + 2] > 245 &&
          pixels[i + 3] === 255
        )
          white++;
      }
      const at = (x, y) => Array.from(ctx.getImageData(x, y, 1, 1).data);
      return {
        width: image.width,
        height: image.height,
        corner: at(0, 0),
        centre: at(image.width / 2, image.height / 2),
        tip: at(image.width / 2, image.height * 0.67),
        visible,
        white,
      };
    },
    { data: bytes.toString("base64"), mime },
  );
}

async function validate(page, outputs) {
  for (const icon of icons) {
    const file = `${iconDir}/${icon.name}`;
    const actual = await inspectImage(page, outputs.get(file), "image/png");
    assert.equal(actual.width, icon.size, file);
    assert.equal(actual.height, icon.size, file);
    if (icon.background === "transparent") {
      assert.equal(actual.corner[3], 0, `${file}: transparent corner`);
      assert.ok(
        actual.visible > icon.size ** 2 * 0.02 &&
          actual.visible < icon.size ** 2 * 0.35,
        `${file}: nonblank ribbon silhouette`,
      );
    } else {
      assert.deepEqual(
        actual.corner,
        [83, 97, 73, 255],
        `${file}: full-bleed olive`,
      );
      assert.ok(
        actual.white > icon.size ** 2 * 0.05,
        `${file}: visible white mark`,
      );
      assert.equal(
        actual.visible,
        icon.size ** 2,
        `${file}: opaque app-store icon`,
      );
    }
  }
  for (const item of social) {
    const file = `artifacts/${item.app}/public/opengraph.jpg`;
    const actual = await inspectImage(page, outputs.get(file), "image/jpeg");
    assert.equal(actual.width, 1200, file);
    assert.equal(actual.height, 630, file);
    assert.ok(actual.white > 1200 * 630 * 0.2, `${file}: visible content band`);
    assert.ok(
      Math.abs(actual.corner[0] - 83) < 4 &&
        Math.abs(actual.corner[1] - 97) < 4 &&
        Math.abs(actual.corner[2] - 73) < 4,
      `${file}: Valo olive`,
    );
  }
  const dashboard = await inspectImage(
    page,
    outputs.get("artifacts/landing/public/compliance-dashboard.jpg"),
    "image/jpeg",
  );
  assert.equal(dashboard.width, 1440);
  assert.equal(dashboard.height, 1000);
  assert.ok(dashboard.white > 1440 * 1000 * 0.2, "Dashboard is nonblank");
}

const args = process.argv.slice(2);
assert.ok(
  args.length === 0 || (args.length === 1 && args[0] === "--check"),
  "Usage: node scripts/branding-assets.mjs [--check]",
);
const check = args[0] === "--check";
const executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined;
const browser = await chromium.launch({
  headless: true,
  executablePath,
  args: [
    "--disable-background-networking",
    "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
  ],
});
try {
  const context = await browser.newContext({
    deviceScaleFactor: 1,
    serviceWorkers: "block",
  });
  await context.route("**/*", (route) => route.abort());
  const page = await context.newPage();
  const outputs = new Map();
  const vectors = new Map();
  await generateVectors(vectors);
  if (check) {
    const files = [
      ...icons.map((icon) => `${iconDir}/${icon.name}`),
      ...social.map((item) => `artifacts/${item.app}/public/opengraph.jpg`),
      "artifacts/landing/public/compliance-dashboard.jpg",
    ];
    for (const file of files)
      outputs.set(file, await readFile(path.join(root, file)));
    for (const [file, bytes] of vectors)
      assert.equal(
        (await readFile(path.join(root, file), "utf8")).replaceAll(
          "\r\n",
          "\n",
        ),
        bytes.toString("utf8").replaceAll("\r\n", "\n"),
        `${file}: vector drift`,
      );
    const expected = new Map();
    await generateIcons(page, expected);
    await generateLogoPreviews(page, vectors, expected);
    for (const [file, bytes] of expected)
      await assertRasterMatch(
        page,
        await readFile(path.join(root, file)),
        bytes,
        file,
      );
  } else {
    const fonts = await fontCss();
    await generateIcons(page, outputs);
    await generateSocial(page, fonts, outputs);
    await generateDashboard(browser, fonts, outputs);
    await generateLogoPreviews(page, vectors, outputs);
    for (const [file, bytes] of vectors) outputs.set(file, bytes);
  }
  await validate(page, outputs);
  if (!check)
    for (const [file, bytes] of outputs) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), bytes);
    }
  for (const [file, bytes] of outputs)
    console.log(
      `${check ? "Verified" : "Generated"} ${file} (${bytes.length} bytes)`,
    );
} finally {
  await browser.close();
}
