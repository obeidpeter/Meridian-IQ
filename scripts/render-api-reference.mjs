// Render artifacts/console/public/api-reference.html from the contract
// (lib/api-spec/openapi.yaml) — zero dependencies, wired as the console's
// prebuild step and runnable directly:
//
//   node scripts/render-api-reference.mjs
//
// PARSING POSTURE. No YAML library is importable from this workspace without
// adding a dependency (yaml/js-yaml exist only as unhoisted transitive deps
// in the pnpm store — an import path into .pnpm would break on any lockfile
// shuffle), so this is a PURPOSE-BUILT extractor for the conventions the
// machine-maintained spec actually uses, not a general YAML parser:
//   - 2-space indentation; paths at indent 2 under `paths:`; methods at 4;
//   - single-line `summary:` / `operationId:` / inline `tags: [a, b]`;
//   - schema pointers as `$ref: "#/components/schemas/X"` and shared error
//     responses as `$ref: "#/components/responses/X"`;
//   - the rare block-scalar `description: >-` folded from its child lines.
// FAIL-LOUD: if those expectations stop matching (no version, implausibly few
// operations) the script exits non-zero so a build breaks visibly instead of
// shipping an empty reference.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SPEC_PATH = path.join(ROOT, "lib/api-spec/openapi.yaml");
const OUT_PATH = path.join(ROOT, "artifacts/console/public/api-reference.html");

const METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);

function fail(msg) {
  console.error(`render-api-reference: ${msg}`);
  process.exit(1);
}

function indentOf(line) {
  let i = 0;
  while (i < line.length && line[i] === " ") i++;
  return i;
}

// Fold a block scalar (`>-` / `|` …): join the following more-indented lines.
function foldBlock(lines, startIdx, parentIndent) {
  const parts = [];
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    if (indentOf(line) <= parentIndent) break;
    parts.push(line.trim());
  }
  return parts.join(" ");
}

function parseSpec(text) {
  const lines = text.split("\n");

  const version = (text.match(/^\s{2}version:\s*(\S+)\s*$/m) ?? [])[1];
  if (!version) fail("could not find info.version in the spec");

  // Top-level tag order (the `tags:` block before `paths:`).
  const tagOrder = [];
  let inTags = false;
  for (const line of lines) {
    if (/^tags:\s*$/.test(line)) {
      inTags = true;
      continue;
    }
    if (inTags) {
      const m = line.match(/^\s{2}- name:\s*(\S+)/);
      if (m) tagOrder.push(m[1]);
      else if (indentOf(line) === 0 && line.trim() !== "") break;
    }
  }

  // Walk `paths:`.
  const pathsStart = lines.findIndex((l) => /^paths:\s*$/.test(l));
  if (pathsStart === -1) fail("could not find the paths: block");

  const ops = [];
  let currentPath = null;
  let op = null; // { method, path, operationId, tags, summary, requestSchema, responses }
  let section = null; // "requestBody" | "responses" | null
  let response = null; // { status, description, schema, sharedRef, isArray, csv }

  const pushOp = () => {
    if (op) {
      if (response) op.responses.push(response);
      response = null;
      ops.push(op);
      op = null;
    }
  };

  for (let i = pathsStart + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    const indent = indentOf(line);
    if (indent === 0) break; // components: — end of paths

    const trimmed = line.trim();

    // A path key: two spaces, starts with /
    const pathMatch = line.match(/^\s{2}(\/\S*):\s*$/);
    if (pathMatch && indent === 2) {
      pushOp();
      currentPath = pathMatch[1];
      continue;
    }

    // A method key under the current path.
    const methodMatch = line.match(/^\s{4}([a-z]+):\s*$/);
    if (methodMatch && indent === 4 && METHODS.has(methodMatch[1])) {
      pushOp();
      op = {
        method: methodMatch[1],
        path: currentPath,
        operationId: null,
        tags: [],
        summary: null,
        requestSchema: null,
        responses: [],
      };
      section = null;
      continue;
    }
    if (!op) continue;

    // Operation-level keys (indent 6).
    if (indent === 6) {
      if (response) {
        op.responses.push(response);
        response = null;
      }
      const kv = trimmed.match(/^([A-Za-z]+):\s*(.*)$/);
      if (kv) {
        const [, k, v] = kv;
        if (k === "operationId") op.operationId = v;
        else if (k === "summary")
          op.summary = /^[>|]/.test(v) ? foldBlock(lines, i + 1, 6) : v;
        else if (k === "tags") {
          const inline = v.match(/^\[(.*)\]$/);
          if (inline) op.tags = inline[1].split(",").map((t) => t.trim());
        } else if (k === "requestBody") section = "requestBody";
        else if (k === "responses") section = "responses";
        else section = null; // parameters, description, …
      }
      continue;
    }

    if (section === "requestBody" && op.requestSchema === null) {
      const ref = trimmed.match(/^\$ref:\s*"#\/components\/schemas\/(\w+)"$/);
      if (ref) op.requestSchema = ref[1];
      continue;
    }

    if (section === "responses") {
      // A status key at indent 8: "200":
      const status = line.match(/^\s{8}"(\d{3})":\s*$/);
      if (status) {
        if (response) op.responses.push(response);
        response = {
          status: status[1],
          description: null,
          schema: null,
          sharedRef: null,
          isArray: false,
          csv: false,
        };
        continue;
      }
      if (!response) continue;
      const sharedRef = trimmed.match(/^\$ref:\s*"#\/components\/responses\/(\w+)"$/);
      if (sharedRef) {
        response.sharedRef = sharedRef[1];
        continue;
      }
      const desc = trimmed.match(/^description:\s*(.*)$/);
      if (desc && indent === 10) {
        response.description = /^[>|]/.test(desc[1])
          ? foldBlock(lines, i + 1, 10)
          : desc[1];
        continue;
      }
      if (/^text\/csv:\s*$/.test(trimmed)) {
        response.csv = true;
        continue;
      }
      if (/^type:\s*array\s*$/.test(trimmed)) {
        response.isArray = true;
        continue;
      }
      const schemaRef = trimmed.match(/^\$ref:\s*"#\/components\/schemas\/(\w+)"$/);
      if (schemaRef && response.schema === null) response.schema = schemaRef[1];
    }
  }
  pushOp();

  if (ops.length < 50) {
    fail(
      `only ${ops.length} operations extracted — the spec's formatting no longer matches this extractor's expectations`,
    );
  }
  return { version, tagOrder, ops };
}

// ---------------------------------------------------------------------------

function esc(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const SHARED_RESPONSE_MEANING = {
  BadRequest: "invalid input",
  Unauthorized: "not signed in / bad credential",
  Forbidden: "not allowed for this principal",
  NotFound: "no such resource in your scope",
  Conflict: "state moved — the request no longer applies",
};

function renderResponse(r) {
  let body;
  if (r.sharedRef) {
    body = `<span class="err">${esc(r.sharedRef)}</span> <span class="dim">— ${esc(
      SHARED_RESPONSE_MEANING[r.sharedRef] ?? "error",
    )}</span>`;
  } else {
    const parts = [];
    if (r.schema) parts.push(`<code>${r.isArray ? `${esc(r.schema)}[]` : esc(r.schema)}</code>`);
    if (r.csv) parts.push(`<code>text/csv</code>`);
    if (r.description) parts.push(`<span class="dim">${esc(r.description)}</span>`);
    body = parts.join(" ") || `<span class="dim">no body</span>`;
  }
  return `<li><span class="status s${r.status[0]}xx">${r.status}</span> ${body}</li>`;
}

function renderOp(op) {
  const title = op.summary ?? op.operationId ?? "";
  const req = op.requestSchema
    ? `<div class="req">Request body: <code>${esc(op.requestSchema)}</code></div>`
    : "";
  const responses = op.responses.length
    ? `<ul class="responses">${op.responses.map(renderResponse).join("")}</ul>`
    : "";
  return `<details class="op" id="${esc(op.operationId ?? `${op.method}-${op.path}`)}">
<summary><span class="method m-${op.method}">${op.method.toUpperCase()}</span><code class="path">/api${esc(op.path)}</code><span class="sum">${esc(title)}</span></summary>
<div class="opbody">${req}${responses}</div>
</details>`;
}

function render({ version, tagOrder, ops }) {
  // Group by first tag; order groups by the spec's tag list, unknowns last.
  const groups = new Map();
  for (const op of ops) {
    const tag = op.tags[0] ?? "untagged";
    if (!groups.has(tag)) groups.set(tag, []);
    groups.get(tag).push(op);
  }
  const orderedTags = [
    ...tagOrder.filter((t) => groups.has(t)),
    ...[...groups.keys()].filter((t) => !tagOrder.includes(t)),
  ];

  const toc = orderedTags
    .map(
      (t) =>
        `<a href="#tag-${esc(t)}">${esc(t)}<span class="count">${groups.get(t).length}</span></a>`,
    )
    .join("");

  const sections = orderedTags
    .map(
      (t) => `<section id="tag-${esc(t)}">
<h2>${esc(t)}</h2>
${groups.get(t).map(renderOp).join("\n")}
</section>`,
    )
    .join("\n");

  const verifySnippet = esc(`import { createHash, createHmac } from "node:crypto";

// Hash your stored whsec_ secret ONCE — that hash is the HMAC key.
const key = createHash("sha256").update(process.env.WEBHOOK_SECRET).digest("hex");

function verify(rawBody, signatureHeader) {
  const expected = createHmac("sha256", key).update(rawBody).digest("hex");
  return expected === signatureHeader; // x-meridian-signature
}`);

  return `<!-- GENERATED FILE — do not hand-edit.
     Rendered from lib/api-spec/openapi.yaml (contract ${version}) by
     scripts/render-api-reference.mjs; the console build's prebuild step
     regenerates it on every build. -->
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>MeridianIQ API reference — v${esc(version)}</title>
<style>
:root{color-scheme:light dark;
  --bg:#fcfcfd;--fg:#17202a;--dim:#5c6672;--line:#e3e7ec;--card:#ffffff;
  --accent:#0f6b54;--code-bg:#f1f4f6;
  --get:#0d6efd;--post:#0f6b54;--put:#8a5a00;--patch:#8a5a00;--delete:#b02a37;
  --s2:#0f6b54;--s4:#8a5a00;--s5:#b02a37}
@media (prefers-color-scheme: dark){:root{
  --bg:#101418;--fg:#e6e9ec;--dim:#98a2ad;--line:#26303a;--card:#161c22;
  --accent:#4cc3a5;--code-bg:#1d242c;
  --get:#5ea3ff;--post:#4cc3a5;--put:#d9a441;--patch:#d9a441;--delete:#e4737e;
  --s2:#4cc3a5;--s4:#d9a441;--s5:#e4737e}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);
  font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:60rem;margin:0 auto;padding:2rem 1.25rem 5rem}
h1{font-size:1.7rem;margin:.2rem 0 .3rem}
h2{font-size:1.15rem;margin:2.2rem 0 .7rem;padding-top:1rem;
  border-top:1px solid var(--line);text-transform:capitalize}
h3{font-size:1rem;margin:1.4rem 0 .4rem}
p{margin:.5rem 0}
.dim{color:var(--dim)}
code{background:var(--code-bg);border-radius:4px;padding:.08em .35em;
  font:.86em/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
pre{background:var(--code-bg);border:1px solid var(--line);border-radius:8px;
  padding: .8rem 1rem;overflow-x:auto}
pre code{background:none;padding:0}
.pill{display:inline-block;background:var(--code-bg);border:1px solid var(--line);
  border-radius:999px;padding:.05rem .6rem;font-size:.8rem;color:var(--dim)}
.intro-card{background:var(--card);border:1px solid var(--line);border-radius:10px;
  padding:.9rem 1.1rem;margin:.9rem 0}
.intro-card h3{margin-top:.1rem}
ul{margin:.4rem 0 .4rem 1.2rem;padding:0}
li{margin:.22rem 0}
nav.toc{display:flex;flex-wrap:wrap;gap:.45rem;margin:1.1rem 0}
nav.toc a{display:inline-flex;align-items:center;gap:.4rem;text-decoration:none;
  color:var(--fg);background:var(--card);border:1px solid var(--line);
  border-radius:999px;padding:.18rem .75rem;font-size:.86rem}
nav.toc a:hover{border-color:var(--accent)}
nav.toc .count{color:var(--dim);font-size:.78rem}
.op{border:1px solid var(--line);border-radius:8px;background:var(--card);
  margin:.45rem 0;overflow:hidden}
.op summary{display:flex;align-items:baseline;gap:.6rem;flex-wrap:wrap;
  padding:.5rem .8rem;cursor:pointer;list-style:none}
.op summary::-webkit-details-marker{display:none}
.op[open] summary{border-bottom:1px solid var(--line)}
.method{font:700 .72rem/1 ui-monospace,monospace;letter-spacing:.03em;
  padding:.22rem .45rem;border-radius:5px;color:#fff;min-width:3.2rem;text-align:center}
.m-get{background:var(--get)}.m-post{background:var(--post)}
.m-put{background:var(--put)}.m-patch{background:var(--patch)}.m-delete{background:var(--delete)}
.path{background:none;font-size:.88em;word-break:break-all}
.sum{color:var(--dim);font-size:.86rem}
.opbody{padding:.55rem .9rem .7rem}
.req{margin:.15rem 0 .35rem}
.responses{list-style:none;margin:.2rem 0 0;padding:0}
.responses li{margin:.28rem 0}
.status{font:700 .74rem/1 ui-monospace,monospace;padding:.16rem .4rem;
  border-radius:4px;color:#fff;margin-right:.35rem}
.s2xx{background:var(--s2)}.s4xx{background:var(--s4)}.s5xx{background:var(--s5)}
.err{font-weight:600}
footer{margin-top:3rem;color:var(--dim);font-size:.85rem;
  border-top:1px solid var(--line);padding-top:1rem}
</style>
</head>
<body>
<main>
<h1>MeridianIQ API reference</h1>
<p><span class="pill">contract v${esc(version)}</span> <span class="pill">base URL <code>/api</code></span></p>
<p class="dim">The full platform contract, grouped by area. Generated from
<code>lib/api-spec/openapi.yaml</code> — the same file the server's request
validation and the apps' typed clients are generated from, so this page can
never disagree with the running API of the same version
(<code>GET /api/healthz</code> reports the server's contract version).</p>

<div class="intro-card">
<h3>Authentication</h3>
<p>Two credentials, resolved in this order:</p>
<ul>
<li><strong>Firm API keys (machine callers)</strong> — <code>Authorization: Bearer mk_…</code>.
A firm admin mints keys under <em>Console → API &amp; webhooks</em>; the secret is
shown <strong>once</strong> and only its hash is stored. A key is pinned to its firm and
carries <em>exactly</em> the capability list it was minted with, from a deliberately
narrow allowlist: <code>invoice.read</code> (pull invoice data),
<code>invoice.write</code> (create/edit drafts), <code>statement.write</code> (push bank
statements). No key can <em>submit</em> to the government rails, touch Clerk,
billing or identity, or mint further credentials. Revocation is immediate —
a revoked or unknown key is a clean <code>401</code>, never a fall-through to
another credential.</li>
<li><strong>Sessions (the web apps &amp; mobile)</strong> — an HttpOnly cookie (or the same
signed token as <code>Authorization: Bearer</code> on mobile). All browser-facing
<em>state-changing</em> requests must also send the CSRF header
<code>x-meridian-csrf: 1</code>, whether they use cookies or Bearer authentication.
Only dedicated machine webhooks are exempt.</li>
</ul>
</div>

<div class="intro-card">
<h3>Webhooks &amp; signatures</h3>
<p>A firm admin registers HTTPS endpoints (<code>POST /api/firm-webhooks</code>) against a
closed event catalogue: <code>invoice.stamped</code>, <code>invoice.settled</code>,
<code>statement.reconciled</code>. Each delivery is a JSON <code>POST</code> carrying the event in
<code>x-meridian-event</code> and a signature in <code>x-meridian-signature</code>.</p>
<p><strong>Signature scheme</strong> — the signing secret (<code>whsec_…</code>) is shown once at
registration; the HMAC key is its <strong>SHA-256 hash as lowercase hex</strong>, not the
secret itself. Verify: <code>HMAC-SHA256(rawBody, sha256hex(secret))</code>, hex-encoded,
must equal the header. Always verify over the <em>raw</em> body bytes:</p>
<pre><code>${verifySnippet}</code></pre>
<p>Failed deliveries retry with exponential backoff up to <strong>5 attempts</strong>, then
park as <strong>dead</strong>; the per-endpoint delivery log
(<code>GET /api/firm-webhooks/{id}/deliveries</code>) shows every attempt, and a dead
delivery can be re-queued for a fresh attempt cycle
(<code>POST …/deliveries/{deliveryId}/retry</code>). Disabling an endpoint stops
deliveries and keeps its history.</p>
</div>

<div class="intro-card">
<h3>Pointer-only payloads</h3>
<p>Everything that leaves the platform — webhook bodies, alert messages — is
<strong>pointer-only by construction</strong>: an entity type, an id and a timestamp, never
amounts, party names, TINs or document content. A mis-registered or compromised
receiver URL learns only that <em>something</em> happened; resolve the details back
through this authenticated API (typically with an API key holding
<code>invoice.read</code>).</p>
</div>

<div class="intro-card">
<h3>Rate limits &amp; errors</h3>
<ul>
<li><strong>600 requests/minute</strong> per principal in general; <strong>60/minute</strong> on
AI-powered (model-calling) routes. Each API key gets its own budget. A
<code>429</code> answers with how long to wait.</li>
<li>Errors are <code>{"error": "human-readable message"}</code> with a conventional status:
<code>400</code> invalid input, <code>401</code> unauthenticated, <code>403</code> not allowed,
<code>404</code> outside your scope, <code>409</code> state moved (e.g. a duplicate
payment intent or a stale lifecycle transition).</li>
<li>Mutating calls are transactional: a <code>4xx</code>/<code>5xx</code> response means the
request's writes were rolled back.</li>
</ul>
</div>

<h2 style="text-transform:none">Endpoints by area</h2>
<nav class="toc">${toc}</nav>
${sections}
<footer>Generated from <code>lib/api-spec/openapi.yaml</code> (contract v${esc(version)})
by <code>scripts/render-api-reference.mjs</code>. Do not edit this file by hand —
edit the spec and rebuild.</footer>
</main>
</body>
</html>
`;
}

const spec = readFileSync(SPEC_PATH, "utf8");
const parsed = parseSpec(spec);
mkdirSync(path.dirname(OUT_PATH), { recursive: true });
writeFileSync(OUT_PATH, render(parsed));
console.log(
  `render-api-reference: wrote ${path.relative(ROOT, OUT_PATH)} — contract v${parsed.version}, ${parsed.ops.length} operations across ${new Set(parsed.ops.map((o) => o.tags[0] ?? "untagged")).size} areas`,
);
