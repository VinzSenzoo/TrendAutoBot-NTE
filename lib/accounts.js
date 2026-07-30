import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

export async function loadAccounts(filePath) {
  try {
    const data = await readFile(filePath, "utf8");
    const parsed = JSON.parse(data);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return { error: "account.json empty or not an array." };
    }
    const accounts = parsed
      .map(normalizeAccount)
      .filter((a) => a.access_token || a.refresh_token);
    if (!accounts.length) {
      return {
        error: "No valid accounts. Need access_token and/or refresh_token.",
      };
    }
    return { accounts };
  } catch (e) {
    if (e.code === "ENOENT") {
      return { error: `account.json not found: ${filePath}` };
    }
    return { error: `Failed to read account.json: ${e.message}` };
  }
}

function normalizeAccount(a) {
  const stakeMin = Number(a.stake_min ?? a.stakeMin);
  const stakeMax = Number(a.stake_max ?? a.stakeMax);
  return {
    access_token: String(a.access_token || a.accessToken || "").trim(),
    refresh_token: String(a.refresh_token || a.refreshToken || "").trim(),
    label: a.label ? String(a.label) : undefined,
    proxy: a.proxy ? String(a.proxy).trim() : undefined,
    stake_min: Number.isFinite(stakeMin) && stakeMin > 0 ? stakeMin : undefined,
    stake_max: Number.isFinite(stakeMax) && stakeMax > 0 ? stakeMax : undefined,
  };
}

export async function saveAccountTokens(filePath, index, tokens) {
  try {
    const raw = await readFile(filePath, "utf8");
    const list = JSON.parse(raw);
    if (!Array.isArray(list) || !list[index]) return;
    const prev = list[index] || {};
    list[index] = {
      ...prev,
      access_token: tokens.access_token,
      refresh_token:
        tokens.refresh_token ?? prev.refresh_token ?? prev.refreshToken ?? "",
    };
    delete list[index].accessToken;
    delete list[index].refreshToken;
    await writeFile(filePath, JSON.stringify(list, null, 2) + "\n", "utf8");
  } catch {
  }
}

export async function saveAccountStake(filePath, index, stakeMin, stakeMax) {
  try {
    const raw = await readFile(filePath, "utf8");
    const list = JSON.parse(raw);
    if (!Array.isArray(list) || !list[index]) return;
    const prev = list[index] || {};
    list[index] = {
      ...prev,
      stake_min: stakeMin,
      stake_max: stakeMax,
    };
    delete list[index].stakeMin;
    delete list[index].stakeMax;
    await writeFile(filePath, JSON.stringify(list, null, 2) + "\n", "utf8");
  } catch {
  }
}

export async function loadProxies(filePath) {
  try {
    const data = await readFile(filePath, "utf8");
    return data
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#"));
  } catch {
    return [];
  }
}

export function parseProxy(proxyString) {
  if (!proxyString || typeof proxyString !== "string" || !proxyString.trim()) {
    return null;
  }
  let s = proxyString.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    s = `http://${s}`;
  }
  const proxyRegex =
    /^(socks5|http|https):\/\/(?:([^:@]+):([^@]*)@)?([^:\/]+):(\d+)\/?$/i;
  const match = s.match(proxyRegex);
  if (!match) return null;
  const [, scheme, username, password, host, port] = match;
  const type = scheme.toLowerCase() === "socks5" ? "socks5" : "http";
  const auth =
    username != null && username !== ""
      ? `${encodeURIComponent(username)}:${encodeURIComponent(password || "")}@`
      : "";
  const url = `${scheme.toLowerCase()}://${auth}${host}:${port}`;
  return { type, url, host, port, username, password };
}

export function resolvePath(baseDir, name) {
  return resolve(baseDir, name);
}

export function fileExists(p) {
  return existsSync(p);
}
