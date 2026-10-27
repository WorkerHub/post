// 移植自 WorkerHub/eNotify 现行 main：worker/src/services/twofa.ts（去掉 email_otp 的发信依赖——
// v1 SMTP 层在后续单接入，先保留 enable/disable 与验证路径，发信方法暂不暴露）。

import type { User2FA } from "../types";

export async function generateTOTPSecret(
  email: string,
): Promise<{ secret: string; uri: string }> {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  const secret = base32Encode(bytes);
  const uri = `otpauth://totp/someday:${encodeURIComponent(email)}?secret=${secret}&issuer=someday&algorithm=SHA1&digits=6&period=30`;
  return { secret, uri };
}

export async function verifyTOTPAsync(
  secret: string,
  code: string,
  env?: { KV: KVNamespace },
  userId?: string,
): Promise<boolean> {
  const time = Math.floor(Date.now() / 1000 / 30);
  for (let i = -1; i <= 1; i++) {
    const expected = await generateTOTPCodeAsync(secret, time + i);
    if (expected === code) {
      if (env && userId) {
        // 防重放：同一 code 90 秒内只能用一次
        const usedKey = `totp_used:${userId}:${code}`;
        const used = await env.KV.get(usedKey);
        if (used) return false;
        await env.KV.put(usedKey, "1", { expirationTtl: 90 });
      }
      return true;
    }
  }
  return false;
}

async function generateTOTPCodeAsync(
  secret: string,
  counter: number,
): Promise<string> {
  const key = base32Decode(secret);
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setBigUint64(0, BigInt(counter));

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(key),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign("HMAC", cryptoKey, buffer);
  const hash = new Uint8Array(signature);

  const offset = hash[hash.length - 1] & 0x0f;
  const binary =
    ((hash[offset] & 0x7f) << 24) |
    ((hash[offset + 1] & 0xff) << 16) |
    ((hash[offset + 2] & 0xff) << 8) |
    (hash[offset + 3] & 0xff);

  const otp = binary % 1000000;
  return otp.toString().padStart(6, "0");
}

export function getAvailable2FAMethods(config: User2FA | null): string[] {
  if (!config) return [];
  const methods: string[] = [];
  if (config.totp_enabled) methods.push("totp");
  if (config.passkey_enabled) methods.push("passkey");
  return methods;
}

// Base32 encode/decode utilities
const BASE32_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(data: Uint8Array): string {
  let result = "";
  let bits = 0;
  let value = 0;

  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result += BASE32_CHARS[(value >>> bits) & 0x1f];
    }
  }

  if (bits > 0) {
    result += BASE32_CHARS[(value << (5 - bits)) & 0x1f];
  }

  return result;
}

function base32Decode(encoded: string): ArrayBuffer {
  const cleaned = encoded.replace(/[=\s]/g, "").toUpperCase();
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;

  for (const char of cleaned) {
    const idx = BASE32_CHARS.indexOf(char);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 0xff);
    }
  }

  return new Uint8Array(bytes).buffer;
}
