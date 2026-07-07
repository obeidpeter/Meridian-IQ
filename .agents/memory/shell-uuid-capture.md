---
name: Shell UUID capture pitfall
description: Why captured psql RETURNING values silently corrupt later shell requests, and how to sanitize them.
---

When capturing an id from `psql -tAc "... RETURNING id"` into a shell variable, psql
can append status noise (e.g. a trailing `\nINSERT 0 1`) to the captured value. That
corrupts anything the var is later interpolated into — HTTP headers (`x-mock-firm`),
JSON bodies, URLs — producing baffling downstream failures (e.g. "everything returns
400/malformed") that look like a server bug but are pure shell contamination.

**Why:** Multi-line psql output is captured whole; the id is only the first token.

**How to apply:** Never trust the raw capture. Pipe through a strict extractor, e.g.
`... | grep -oiE '[0-9a-f-]{36}' | head -1` for a UUID. No `python3` in this shell —
use `node`/`grep`/`sed` for parsing.
