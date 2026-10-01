import crypto from "node:crypto";

const PUBLIC_KEYS_URL = "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com";

let keyCache = null;
let keyCacheExpiry = 0;

function base64UrlDecode(segment) {
  return Buffer.from(segment.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

async function getPublicKeys() {
  const now = Date.now();
  if (keyCache && now < keyCacheExpiry) return keyCache;

  const res = await fetch(PUBLIC_KEYS_URL);
  if (!res.ok) {
    throw new Error(`Failed to fetch Firebase public keys: HTTP ${res.status}`);
  }

  const keys = await res.json();
  const cacheControl = res.headers.get("cache-control") || "";
  const maxAgeMatch = cacheControl.match(/max-age=(\d+)/);
  const maxAge = maxAgeMatch ? Number(maxAgeMatch[1]) : 300;

  keyCache = keys;
  keyCacheExpiry = now + maxAge * 1000;
  return keys;
}

function parseToken(token) {
  if (typeof token !== "string") throw new Error("Invalid token");
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Invalid token format");
  return {
    header: JSON.parse(base64UrlDecode(parts[0])),
    payload: JSON.parse(base64UrlDecode(parts[1])),
    signature: parts[2],
    signingInput: `${parts[0]}.${parts[1]}`,
  };
}

export async function verifyIdToken(token) {
  const projectId = process.env.VITE_FIREBASE_PROJECT_ID || process.env.FIREBASE_PROJECT_ID;
  if (!projectId) {
    throw new Error("Firebase project ID not configured");
  }

  const { header, payload, signature, signingInput } = parseToken(token);

  if (header.alg !== "RS256") {
    throw new Error("Invalid token algorithm");
  }

  const publicKeys = await getPublicKeys();
  const cert = publicKeys[header.kid];
  if (!cert) {
    throw new Error("Unknown signing key");
  }

  const verifier = crypto.createVerify("RSA-SHA256");
  verifier.update(signingInput);
  const isValid = verifier.verify(cert, Buffer.from(signature, "base64url"));
  if (!isValid) {
    throw new Error("Invalid token signature");
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp < nowSec) {
    throw new Error("Token expired");
  }
  if (payload.aud !== projectId) {
    throw new Error("Token audience mismatch");
  }
  if (payload.iss !== `https://securetoken.google.com/${projectId}`) {
    throw new Error("Token issuer mismatch");
  }
  if (!payload.sub) {
    throw new Error("Token missing subject");
  }

  return {
    uid: payload.sub,
    email: payload.email || null,
    ...payload,
  };
}

export async function verifyAuth(req) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw new Error("Missing or invalid Authorization header");
  }

  const token = authHeader.split("Bearer ")[1];

  return await verifyIdToken(token);
}

export function requireAuth(handler) {
  return async (req, res) => {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    for (const [key, value] of Object.entries(corsHeaders)) {
      res.setHeader(key, value);
    }

    if (req.method === "OPTIONS") return res.status(204).end();

    try {
      req.user = await verifyAuth(req);
      return handler(req, res);
    } catch (error) {
      return res.status(401).json({ error: error.message });
    }
  };
}
