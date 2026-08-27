import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
const [mode, input, output] = process.argv.slice(2);
const passphrase = process.env.BACKUP_PASSPHRASE;
const MAGIC = Buffer.from("MIQDR001", "ascii");
if (!mode || !input || !output || !passphrase) {
  console.error("usage: BACKUP_PASSPHRASE=... node miq-dr-crypt.mjs enc|dec input output");
  process.exit(2);
}
const deriveKey = (salt) => pbkdf2Sync(passphrase, salt, 600000, 32, "sha256");
if (mode === "enc") {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(salt), iv);
  const plaintext = readFileSync(input);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  writeFileSync(output, Buffer.concat([MAGIC, salt, iv, tag, ciphertext]), { mode: 0o600 });
  console.log("encrypted " + input + " -> " + output);
} else if (mode === "dec") {
  const payload = readFileSync(input);
  if (payload.length < 52 || !payload.subarray(0, 8).equals(MAGIC)) throw new Error("invalid MeridianIQ DR archive");
  const salt = payload.subarray(8, 24);
  const iv = payload.subarray(24, 36);
  const tag = payload.subarray(36, 52);
  const ciphertext = payload.subarray(52);
  const decipher = createDecipheriv("aes-256-gcm", deriveKey(salt), iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  writeFileSync(output, plaintext, { mode: 0o600 });
  console.log("decrypted " + input + " -> " + output);
} else {
  throw new Error("mode must be enc or dec");
}
