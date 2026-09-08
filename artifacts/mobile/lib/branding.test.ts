import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { test } from "node:test";

const mobileRoot = join(import.meta.dirname, "..");
const repoRoot = join(mobileRoot, "..", "..");
const read = (file: string) => readFileSync(join(mobileRoot, file), "utf8");
const config = JSON.parse(read("app.json")).expo;
const require = createRequire(import.meta.url);
const expoRequire = createRequire(require.resolve("expo/package.json"));
const { IOSConfig, AndroidConfig } = expoRequire("@expo/config-plugins");

test("Valo display branding preserves installed-app and deployment identities", () => {
  assert.equal(config.name, "Valo");
  assert.equal(config.slug, "mobile");
  assert.equal(config.ios.bundleIdentifier, "com.meridianiq.mobile");
  assert.equal(config.android.package, "com.meridianiq.mobile");
  assert.deepEqual(config.scheme, ["mobile", "valo"]);
  const eas = JSON.parse(read("eas.json"));
  for (const profile of ["development", "preview", "production"]) {
    assert.equal(
      eas.build[profile].env.EXPO_PUBLIC_DOMAIN,
      "valo-platform.replit.app",
    );
  }
});

test("public Replit defaults match the reviewed mobile production domain", () => {
  const eas = JSON.parse(read("eas.json"));
  const origin = `https://${eas.build.production.env.EXPO_PUBLIC_DOMAIN}`;
  for (const file of [
    "artifacts/api-server/src/routes/auth.ts",
    "scripts/src/ops/sweep-ping.mjs",
  ]) {
    const source = readFileSync(join(repoRoot, file), "utf8");
    const origins = source.match(/https:\/\/[a-z0-9-]+\.replit\.app\b/g) ?? [];
    assert.ok(origins.length > 0, `${file}: public URL default is present`);
    assert.deepEqual(new Set(origins), new Set([origin]), file);
  }
});

test("installed Expo iOS transform registers both old and new deep links", () => {
  const plist = IOSConfig.Scheme.setScheme(config, {
    ITSAppUsesNonExemptEncryption: false,
  });
  const schemes = IOSConfig.Scheme.getSchemesFromPlist(plist);
  assert.ok(schemes.includes("mobile"));
  assert.ok(schemes.includes("valo"));
  assert.ok(schemes.includes("com.meridianiq.mobile"));
  assert.equal(plist.ITSAppUsesNonExemptEncryption, false);
});

test("installed Expo Android transform adds valo without duplicating the legacy scheme", () => {
  const manifest = {
    manifest: {
      application: [
        {
          activity: [
            {
              $: {
                "android:name": ".MainActivity",
                "android:launchMode": "singleTask",
              },
            },
          ],
        },
      ],
    },
  };
  const legacy = AndroidConfig.Scheme.setScheme(
    { ...config, scheme: "mobile" },
    manifest,
  );
  const upgraded = AndroidConfig.Scheme.setScheme(config, legacy);
  const schemes = AndroidConfig.Scheme.getSchemesFromManifest(upgraded);
  assert.equal(
    schemes.filter((scheme: string) => scheme === "mobile").length,
    1,
  );
  assert.equal(schemes.filter((scheme: string) => scheme === "valo").length, 1);
  const repeated = AndroidConfig.Scheme.setScheme(config, upgraded);
  assert.deepEqual(
    AndroidConfig.Scheme.getSchemesFromManifest(repeated),
    schemes,
  );
});

test("native sign-in uses the shared ribbon geometry and Valo native-client header", () => {
  const native = read("components/valo-mark.tsx");
  const web = readFileSync(
    join(repoRoot, "lib/web-ui/src/valo-mark.tsx"),
    "utf8",
  );
  assert.equal(native.match(/d="([^"]+)"/)?.[1], web.match(/d="([^"]+)"/)?.[1]);
  assert.match(native, /from "react-native-svg"/);
  assert.ok(web.match(/d="([^"]+)"/)?.[1]?.includes("M22.4 3"));
  assert.match(native, /fill="currentColor"/);
  assert.doesNotMatch(native, /strokeWidth/);
  assert.match(native, /accessible=\{false\}/);
  const signIn = read("components/sign-in.tsx");
  assert.match(signIn, /<ValoMark width=\{44\} height=\{44\}/);
  assert.match(signIn, /backgroundColor: "#536149"/);
  assert.doesNotMatch(signIn, /<Feather|lime document mark/);
  assert.match(signIn, /headers: \{ "X-Valo-Client": "mobile" \}/);
  assert.match(signIn, /useLogin\(\{ request: MOBILE_CLIENT_REQUEST \}\)/);
  assert.match(
    signIn,
    /useTotpChallenge\(\{ request: MOBILE_CLIENT_REQUEST \}\)/,
  );
});

test("launcher, adaptive, splash and notification assets have dedicated valid PNGs", () => {
  const notification = config.plugins.find(
    (entry: unknown) =>
      Array.isArray(entry) && entry[0] === "expo-notifications",
  )[1];
  const images: Array<[string, number]> = [
    [config.icon, 1024],
    [config.android.adaptiveIcon.foregroundImage, 1024],
    [config.splash.image, 1024],
    [notification.icon, 96],
  ];
  assert.equal(new Set(images.map(([file]) => file)).size, 4);
  assert.equal(config.android.adaptiveIcon.backgroundColor, "#536149");
  assert.equal(notification.color, "#536149");
  for (const [file, size] of images) {
    const png = readFileSync(join(mobileRoot, file));
    assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", file);
    assert.equal(png.readUInt32BE(16), size, file);
    assert.equal(png.readUInt32BE(20), size, file);
  }
});
