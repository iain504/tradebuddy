import crypto from "crypto";

/**
 * AES-256-GCM encryption for broker credentials at rest.
 * Key is derived from ENCRYPTION_KEY env var (set a strong random value in production).
 */
const SECRET = process.env.ENCRYPTION_KEY || "dev-insecure-key-change-me";
if (!process.env.ENCRYPTION_KEY) {
  console.warn("[crypto] ENCRYPTION_KEY not set - using insecure development key. Set it in .env for production!");
}
const KEY = crypto.createHash("sha256").update(SECRET).digest();

export function encrypt(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

export function decrypt(payload: string): string {
  const buf = Buffer.from(payload, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}
