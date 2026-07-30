export function decodeJwtPayload(token) {
  try {
    const parts = String(token).split(".");
    if (parts.length !== 3) return null;
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

export function isJwt(token) {
  return typeof token === "string" && token.split(".").length === 3;
}

export function isTokenExpired(token, skewSec = 90) {
  const decoded = decodeJwtPayload(token);
  if (!decoded || typeof decoded.exp !== "number") return false;
  const remaining = decoded.exp - Math.floor(Date.now() / 1000);
  return remaining <= skewSec;
}

export function tokenExpiresInSec(token) {
  const decoded = decodeJwtPayload(token);
  if (!decoded || typeof decoded.exp !== "number") return null;
  return decoded.exp - Math.floor(Date.now() / 1000);
}
