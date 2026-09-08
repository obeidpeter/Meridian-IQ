# Valo Logo

## Design

The folded-ribbon V connects two shapes through open negative space: records
coming together, with a clear direction forward. Its longer right-hand ribbon
and softened lower tip distinguish it from a plain chevron. The wordmark uses
Inter SemiBold with zero added letter spacing, matching the platform typography.

The identity uses olive `#536149`, graphite `#252a24` and white. It is flat,
single-colour compatible and independent of shadows, gradients or animation.

## Files

Production-ready SVG and transparent PNG files are in
`artifacts/landing/public/brand/` and are served at `/brand/`:

- `valo-logo.svg` / `valo-logo.png`: olive mark and graphite wordmark.
- `valo-logo-white.svg` / `valo-logo-white.png`: reversed identity for dark surfaces.
- `valo-logo-mono.svg` / `valo-logo-mono.png`: graphite monochrome identity.
- `valo-mark.svg` / `valo-mark.png`: standalone olive symbol.
- `Inter-LICENSE.txt`: license for the outlined Inter wordmark.

The SVG wordmarks are outlined paths: recipients do not need a font installed.
The web and native symbols use the same path geometry. Standalone files have
an accessible title; embedded decorative symbols defer to their labelled link
or adjacent Valo text, avoiding duplicate screen-reader announcements.

## Usage

- Use the primary identity on light backgrounds and white on dark backgrounds.
- Keep at least one quarter of the mark height clear around the identity.
- Preserve the aspect ratio and the open diagonal gap.
- Use the symbol alone for small app icons; do not compress the full wordmark.
- In interface headers the symbol is 28-32px; existing smaller utility marks
  remain supported. Favicons use a padded olive tile for browser visibility.
- Do not replace customer/firm logos, legal entity names, historical evidence,
  existing sessions, domains, signing identifiers or provider credentials.

## Regeneration and Checks

Run `node scripts/branding-assets.mjs` to regenerate icons, five favicons,
four social previews, the synthetic dashboard preview and the brand downloads.
This uses installed fonts and browser tooling without network requests.
Run `node scripts/branding-assets.mjs --check` to check vector equality, raster
geometry, icon dimensions, alpha/background requirements and preview sanity.
Use `PLAYWRIGHT_EXECUTABLE_PATH` when a system browser is required.

Shared UI tests also enforce web/native/favicon/download geometry parity.
The branding gate requires the current mark in all five web favicons.

Mobile launcher, splash and notification source assets are updated, but existing
installed native apps require a separately signed store build to receive them.
A Replit web deployment does not update an already installed native binary.
