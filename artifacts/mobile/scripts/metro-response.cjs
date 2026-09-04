const { stripVTControlCharacters } = require("node:util");

async function metroResponseError(
  response,
  { limit = 8192, timeoutMs = 2000 } = {},
) {
  const reader = response.body?.getReader();
  let text = "";
  let truncated = false;
  if (reader) {
    const chunks = [];
    let size = 0;
    const timer = setTimeout(() => {
      truncated = true;
      void reader.cancel().catch(() => {});
    }, timeoutMs);
    try {
      while (size < limit) {
        const { done, value } = await reader.read();
        if (done) break;
        const remaining = limit - size;
        chunks.push(Buffer.from(value.subarray(0, remaining)));
        size += Math.min(value.length, remaining);
        if (size === limit) {
          truncated = true;
          break;
        }
      }
      text = Buffer.concat(chunks).toString("utf8");
    } catch (error) {
      text = `Diagnostic body could not be read: ${error.message}`;
    } finally {
      clearTimeout(timer);
      void reader.cancel().catch(() => {});
    }
  }
  try {
    const body = JSON.parse(text);
    if (typeof body.message === "string") text = body.message;
  } catch {
    /* Truncated JSON or plain-text Metro errors remain readable. */
  }
  const detail = stripVTControlCharacters(text).slice(0, limit).trim();
  return new Error(
    `Metro HTTP ${response.status}: ${detail || "no diagnostic body"}${truncated ? " [diagnostic truncated]" : ""}`,
  );
}

module.exports = { metroResponseError };
