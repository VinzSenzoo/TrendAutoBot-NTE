import axios from "axios";
import { SocksProxyAgent } from "socks-proxy-agent";
import { HttpsProxyAgent } from "https-proxy-agent";

const API_BASE = "https://api.trendbtc.app";

export class TrendBTCClient {
  constructor(opts) {
    this.accessToken = opts.accessToken || "";
    this.refreshToken = opts.refreshToken || "";
    this.proxy = opts.proxy || null;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.onTokensUpdated = opts.onTokensUpdated || null;
    this.onLog = opts.onLog || (() => {});
    this._refreshing = null;
  }

  setTokens(accessToken, refreshToken) {
    if (accessToken) this.accessToken = accessToken;
    if (refreshToken) this.refreshToken = refreshToken;
  }

  getAgents() {
    if (!this.proxy) return {};
    const agent =
      this.proxy.type === "socks5"
        ? new SocksProxyAgent(this.proxy.url)
        : new HttpsProxyAgent(this.proxy.url);
    return { httpsAgent: agent, httpAgent: agent };
  }

  async refreshAccessToken() {
    if (!this.refreshToken) {
      this.onLog("No refresh_token available.");
      return false;
    }
    if (this._refreshing) return this._refreshing;

    this._refreshing = (async () => {
      try {
        const response = await axios.post(
          `${API_BASE}/api/auth/refresh`,
          { refreshToken: this.refreshToken },
          {
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
              "User-Agent": "Mozilla/5.0",
            },
            timeout: this.timeoutMs,
            ...this.getAgents(),
            validateStatus: () => true,
          }
        );

        if (response.status < 200 || response.status >= 300) {
          return false;
        }

        const data = response.data || {};
        const session = data.session || data;
        const access =
          session.accessToken ||
          session.access_token ||
          data.accessToken ||
          data.access_token;
        const refresh =
          session.refreshToken ||
          session.refresh_token ||
          data.refreshToken ||
          data.refresh_token ||
          this.refreshToken;

        if (!access) {
          return false;
        }

        this.accessToken = access;
        if (refresh) this.refreshToken = refresh;

        if (this.onTokensUpdated) {
          await this.onTokensUpdated({
            accessToken: this.accessToken,
            refreshToken: this.refreshToken,
          });
        }
        return true;
      } catch {
        return false;
      } finally {
        this._refreshing = null;
      }
    })();

    return this._refreshing;
  }

  async request(method, path, body = null, opts = {}) {
    const auth = opts.auth !== false;
    const retried = opts.retried === true;

    const headers = {
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0",
    };
    if (auth && this.accessToken) {
      headers.Authorization = `Bearer ${this.accessToken}`;
    }
    if (body != null) headers["Content-Type"] = "application/json";

    try {
      const config = {
        method,
        url: `${API_BASE}${path}`,
        headers,
        timeout: this.timeoutMs,
        ...this.getAgents(),
        validateStatus: () => true,
      };
      if (body != null) config.data = body;

      const response = await axios(config);
      const data = response.data;

      if (
        (response.status === 401 || response.status === 403) &&
        auth &&
        !retried
      ) {
        const ok = await this.refreshAccessToken();
        if (ok) {
          return this.request(method, path, body, { ...opts, retried: true });
        }
      }

      if (response.status < 200 || response.status >= 300) {
        const errObj = data?.error;
        const msg =
          (typeof errObj === "object" && (errObj.message || errObj.code)) ||
          data?.message ||
          (typeof data === "string" ? data : null) ||
          response.statusText;
        const e = new Error(`HTTP ${response.status}: ${msg}`);
        e.status = response.status;
        e.data = data;
        throw e;
      }

      return data;
    } catch (error) {
      if (error.status) throw error;
      if (
        (error.response?.status === 401 || error.response?.status === 403) &&
        auth &&
        !retried
      ) {
        const ok = await this.refreshAccessToken();
        if (ok) return this.request(method, path, body, { ...opts, retried: true });
      }
      throw new Error(error.message || String(error));
    }
  }

  me() {
    return this.request("get", "/api/me").then((d) => d.user ?? d);
  }

  balances() {
    return this.request("get", "/api/me/balances").then((d) => {
      if (Array.isArray(d)) return d;
      if (Array.isArray(d?.balances)) return d.balances;
      return d?.balances ?? d;
    });
  }

  currentRounds() {
    return this.request("get", "/api/markets/current-rounds", null, {
      auth: false,
    }).then((d) => d.rounds ?? []);
  }

  btcPrice() {
    return this.request("get", "/api/prices/btc", null, { auth: false });
  }

  btcPriceHistory() {
    return this.request("get", "/api/prices/btc/history", null, {
      auth: false,
    }).then((d) => d.points ?? []);
  }

  myActivePredictions() {
    return this.request("get", "/api/markets/my-active-predictions").then(
      (d) => d.predictions ?? []
    );
  }

  myPredictions(q = {}) {
    const sp = new URLSearchParams();
    if (q.limit) sp.set("limit", String(q.limit));
    if (q.cursor) sp.set("cursor", q.cursor);
    const qs = sp.toString();
    return this.request(
      "get",
      `/api/predictions/my${qs ? `?${qs}` : ""}`
    ).then((d) => d);
  }

  predictionLimits() {
    return this.request("get", "/api/markets/btc/prediction-limits").then(
      (d) => d.limits ?? d
    );
  }

  placePrediction(p) {
    const body = {
      roundId: p.roundId,
      direction: String(p.direction).toUpperCase(),
      stakeAmount: p.stakeAmount,
      idempotencyKey: p.idempotencyKey || crypto.randomUUID(),
    };
    return this.request("post", "/api/predictions", body).then(
      (d) => d.prediction ?? d
    );
  }

  getTasks() {
    return this.request("get", "/api/tasks").then((d) => d.tasks ?? []);
  }

  async getMyTaskCompletions(limit = 50) {
    const all = [];
    let cursor = null;
    for (let i = 0; i < 20; i++) {
      const sp = new URLSearchParams();
      sp.set("limit", String(limit));
      if (cursor) sp.set("cursor", cursor);
      const data = await this.request("get", `/api/me/tasks?${sp.toString()}`);
      const rows = data.completions || data.items || data.tasks || [];
      if (!Array.isArray(rows) || !rows.length) break;
      all.push(...rows);
      cursor = data.nextCursor || data.cursor || rows[rows.length - 1]?.id;
      if (!data.nextCursor && !data.hasMore) break;
      if (rows.length < limit) break;
    }
    return all;
  }

  taskAction(taskId, action, proof = null) {
    const isSubmit = action === "submit";
    return this.request(
      "post",
      `/api/tasks/${encodeURIComponent(taskId)}/${action}`,
      isSubmit ? proof || {} : null
    );
  }

  async openTaskTracking(trackingUrl) {
    if (!trackingUrl) return null;
    try {
      const url = new URL(trackingUrl);
      if (!url.searchParams.has("response")) {
        url.searchParams.set("response", "json");
      }
      if (url.hostname.includes("trendbtc.app")) {
        return await this.request("get", url.pathname + url.search);
      }
      const res = await axios.get(url.toString(), {
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          Accept: "application/json",
        },
        timeout: this.timeoutMs,
        ...this.getAgents(),
        validateStatus: () => true,
      });
      return res.data;
    } catch (e) {
      return { error: e.message };
    }
  }

  getBoxes() {
    return this.request("get", "/api/boxes", null, { auth: false }).then(
      (d) => d.boxes ?? []
    );
  }

  getBoxStatus(boxId = null) {
    const q = boxId ? `?boxId=${encodeURIComponent(boxId)}` : "";
    return this.request("get", `/api/boxes/status${q}`);
  }

  getBoxUnlock() {
    return this.request("get", "/api/boxes/unlock").then(
      (d) => d.unlock ?? d
    );
  }

  openBox(boxId, useTicket = false) {
    return this.request(
      "post",
      `/api/boxes/${encodeURIComponent(boxId)}/open`,
      { useTicket: !!useTicket }
    ).then((d) => d.opening ?? d);
  }

  getOnboarding() {
    return this.request("get", "/api/me/onboarding");
  }

  claimOnboarding() {
    return this.request("post", "/api/me/onboarding/claim");
  }

  getFaucet() {
    return this.request("get", "/api/me/faucet");
  }

  claimFaucet() {
    return this.request("post", "/api/me/faucet/claim");
  }

  getTaskCooldown() {
    return this.request("get", "/api/me/task-cooldown");
  }
}

export function parseBalances(balances) {
  const out = { usd: 0, trend: 0, sol: 0, raw: balances };

  const pickFromArray = (arr) => {
    const get = (...names) => {
      for (const name of names) {
        const row = arr.find(
          (b) =>
            b &&
            (String(b.currency || "").toUpperCase() === name.toUpperCase() ||
              String(b.asset || "").toUpperCase() === name.toUpperCase() ||
              String(b.symbol || "").toUpperCase() === name.toUpperCase() ||
              String(b.code || "").toUpperCase() === name.toUpperCase())
        );
        if (row != null) {
          const n = Number(
            row.balance ?? row.amount ?? row.available ?? row.value
          );
          if (Number.isFinite(n)) return n;
        }
      }
      return null;
    };
    const usd = get("USD_BALANCE", "USDT", "USD", "USDC");
    const trend = get("TREND", "TREND_BALANCE");
    const sol = get("SOL", "SOL_BALANCE");
    if (usd != null) out.usd = usd;
    if (trend != null) out.trend = trend;
    if (sol != null) out.sol = sol;
  };

  if (Array.isArray(balances)) {
    pickFromArray(balances);
    return out;
  }

  if (balances && typeof balances === "object") {
    if (Array.isArray(balances.balances)) {
      pickFromArray(balances.balances);
      return out;
    }
    for (const key of [
      "USD_BALANCE",
      "usd",
      "USD",
      "usdt",
      "USDT",
      "balanceUsd",
      "availableUsd",
    ]) {
      if (balances[key] != null && Number.isFinite(Number(balances[key]))) {
        out.usd = Number(balances[key]);
        break;
      }
    }
    if (balances.TREND != null) out.trend = Number(balances.TREND) || 0;
    if (balances.SOL != null) out.sol = Number(balances.SOL) || 0;
  }

  return out;
}
