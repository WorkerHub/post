// 移植自 WorkerHub/eNotify 现行 main：worker/src/core/auth.ts（未改动算法与参数）。

import type { JWTPayload } from "../types";

// ─── Buffer helpers ───────────────────────────────────────────────────────────

function bufToHex(buf: Uint8Array | ArrayBuffer): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = Number.parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

// ─── Base64url helpers ────────────────────────────────────────────────────────

function base64urlEncodeString(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = "";
  for (let i = 0; i < bytes.length; i++)
    binary += String.fromCharCode(bytes[i]);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64urlEncodeBuffer(input: ArrayBuffer): string {
  const bytes = new Uint8Array(input);
  let binary = "";
  for (let i = 0; i < bytes.length; i++)
    binary += String.fromCharCode(bytes[i]);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64urlDecodeToString(input: string): string {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4;
  return atob(pad ? padded + "=".repeat(4 - pad) : padded);
}

function base64urlDecodeToBuffer(input: string): ArrayBuffer {
  const binary = base64urlDecodeToString(input);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

// ─── Password hashing ─────────────────────────────────────────────────────────

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(32));

  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );

  const hashBuffer = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100_000, hash: "SHA-256" },
    keyMaterial,
    256,
  );

  return `${bufToHex(salt)}:${bufToHex(hashBuffer)}`;
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const colonIdx = stored.indexOf(":");
  if (colonIdx === -1) return false;

  const saltHex = stored.slice(0, colonIdx);
  const storedHash = stored.slice(colonIdx + 1);
  if (!saltHex || !storedHash) return false;

  const salt = hexToBytes(saltHex);

  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );

  const hashBuffer = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100_000, hash: "SHA-256" },
    keyMaterial,
    256,
  );

  const hashHex = bufToHex(hashBuffer);

  // Constant-time comparison
  if (hashHex.length !== storedHash.length) return false;
  let diff = 0;
  for (let i = 0; i < hashHex.length; i++) {
    diff |= hashHex.charCodeAt(i) ^ storedHash.charCodeAt(i);
  }
  return diff === 0;
}

// ─── JWT ──────────────────────────────────────────────────────────────────────

export async function signJWT(
  payload: JWTPayload,
  secret: string,
): Promise<string> {
  const encodedHeader = base64urlEncodeString(
    JSON.stringify({ alg: "HS256", typ: "JWT" }),
  );
  const encodedPayload = base64urlEncodeString(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(signingInput),
  );

  return `${signingInput}.${base64urlEncodeBuffer(signature)}`;
}

export async function verifyJWT(
  token: string,
  secret: string,
): Promise<JWTPayload | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );

  let valid: boolean;
  try {
    valid = await crypto.subtle.verify(
      "HMAC",
      key,
      base64urlDecodeToBuffer(encodedSignature),
      new TextEncoder().encode(signingInput),
    );
  } catch {
    return null;
  }

  if (!valid) return null;

  let header: { alg?: string; typ?: string };
  try {
    header = JSON.parse(base64urlDecodeToString(encodedHeader));
  } catch {
    return null;
  }
  if (header.alg !== "HS256") return null;

  let payload: JWTPayload;
  try {
    payload = JSON.parse(base64urlDecodeToString(encodedPayload));
  } catch {
    return null;
  }

  if (typeof payload.exp === "number" && Date.now() / 1000 > payload.exp)
    return null;

  if (!payload.sub || !payload.role || !payload.jti || !payload.sid)
    return null;

  return payload;
}

// ─── ID generation ────────────────────────────────────────────────────────────

export async function safeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const va = new Uint8Array(ha);
  const vb = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

export function generateId(): string {
  return crypto.randomUUID();
}

export function generateJti(): string {
  return crypto.randomUUID();
}
