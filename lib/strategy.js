const RULES = {
  rakeRate: 0.05,
  earlyMultiplierMax: 1.5,
  earlyMultiplierMin: 0.3,
  participationTrend: 0,
  correctPredictionTrend: 2,
  stakeTrendRate: 0.01,
};

export function earlyMultiplier(startTime, lockTime, now = Date.now()) {
  const lo = Math.min(RULES.earlyMultiplierMin, RULES.earlyMultiplierMax);
  const hi = Math.max(RULES.earlyMultiplierMin, RULES.earlyMultiplierMax);
  const start = new Date(startTime).getTime();
  const span = new Date(lockTime).getTime() - start;
  if (!Number.isFinite(span) || span <= 0) return lo;
  const t = Math.min(Math.max(now - start, 0), span);
  return Math.round(1e6 * (hi - ((hi - lo) * t) / span)) / 1e6;
}

export function estimatePayout(stake, direction, round, now = Date.now()) {
  const mult = earlyMultiplier(round.startTime, round.lockTime, now);
  const c = Number.isFinite(stake) && stake > 0 ? stake : 0;
  const s = c * mult;
  const sideWeight =
    (("UP" === direction ? round.upWeight : round.downWeight) || 0) + s;
  const oppPool =
    Math.max("UP" === direction ? round.downPool : round.upPool, 0) *
    (1 - RULES.rakeRate);
  const payoutAmount = Number(
    (c + (sideWeight > 0 && c > 0 ? (oppPool * s) / sideWeight : 0)).toFixed(2)
  );
  const coefficient = c > 0 ? Number((payoutAmount / c).toFixed(2)) : 1;
  const trendReward = Math.round(
    RULES.participationTrend +
      RULES.correctPredictionTrend +
      s * RULES.stakeTrendRate
  );
  return {
    timeMultiplier: mult,
    coefficient,
    payoutAmount,
    netUsd: Number((payoutAmount - c).toFixed(2)),
    trendRewardIfWin: trendReward,
  };
}

export function decideDirection(input) {
  const { round, price, history = [], options = {} } = input;
  const analysisSec = options.analysisSec ?? 65;
  const minConfidence = options.minConfidence ?? 0.48;

  const now = Date.now();
  const startMs = round?.startTime ? Date.parse(round.startTime) : NaN;
  const lockMs = round?.lockTime ? Date.parse(round.lockTime) : NaN;
  const secsSinceStart = Number.isFinite(startMs) ? (now - startMs) / 1000 : 0;
  const secsToLock = Number.isFinite(lockMs) ? (lockMs - now) / 1000 : 999;

  const current =
    num(price?.medianPrice) ?? num(price?.price) ?? lastPrice(history);
  const startPrice = num(round?.startPrice);
  const points = normalizeHistory(history);

  const analysis = [];
  const metrics = {
    current: current ?? "n/a",
    startPrice: startPrice ?? "n/a",
    secsSinceStart: roundN(secsSinceStart, 1),
    secsToLock: Math.round(secsToLock),
    analysisSec,
  };

  const scores = scoreSignals({
    current,
    startPrice,
    points,
    price,
    analysis,
    metrics,
  });

  let direction = null;
  let confidence = 0;
  if (scores.total > 0 && Math.abs(scores.up - scores.down) > 1e-9) {
    direction = scores.up > scores.down ? "UP" : "DOWN";
    const edge = Math.abs(scores.up - scores.down) / scores.total;
    const agreeBonus = scores.agreeRatio * 0.2;
    confidence = clamp(edge * 0.75 + agreeBonus + scores.quality * 0.15, 0, 1);
  }

  metrics.upScore = roundN(scores.up, 3);
  metrics.downScore = roundN(scores.down, 3);
  metrics.confidence = roundN(confidence, 3);
  metrics.agreeRatio = roundN(scores.agreeRatio, 2);

  analysis.push(
    `Score UP ${scores.up.toFixed(2)} / DOWN ${scores.down.toFixed(2)} conf ${(confidence * 100).toFixed(0)}%`
  );

  if (secsSinceStart < analysisSec) {
    const left = Math.max(0, analysisSec - secsSinceStart);
    analysis.unshift(`Analyzing ${secsSinceStart.toFixed(0)}/${analysisSec}s (${left.toFixed(0)}s left)`);
    if (direction) analysis.push(`Lean ${direction}`);
    return {
      phase: "analyzing",
      direction,
      confidence,
      shouldBet: false,
      reason: `Analyzing ${left.toFixed(0)}s left`,
      analysis,
      metrics,
    };
  }

  analysis.unshift("Analysis done");

  if (secsToLock <= 8) {
    return {
      phase: "decide",
      direction,
      confidence,
      shouldBet: false,
      reason: "Too close to lock",
      analysis: [...analysis, "Skip near lock"],
      metrics,
    };
  }

  if (!direction || confidence < minConfidence) {
    if (
      current != null &&
      startPrice != null &&
      startPrice > 0 &&
      Math.abs(((current - startPrice) / startPrice) * 10000) >= 3
    ) {
      direction = current > startPrice ? "UP" : "DOWN";
      confidence = Math.max(confidence, 0.5);
      analysis.push(`Fallback ${direction}`);
    } else {
      return {
        phase: "decide",
        direction,
        confidence,
        shouldBet: false,
        reason: `Skip low conf ${(confidence * 100).toFixed(0)}%`,
        analysis: [...analysis, "Skip low confidence"],
        metrics,
      };
    }
  }

  if (confidence < minConfidence) {
    return {
      phase: "decide",
      direction,
      confidence,
      shouldBet: false,
      reason: `Skip conf ${(confidence * 100).toFixed(0)}%`,
      analysis: [...analysis, "Skip below min conf"],
      metrics,
    };
  }

  analysis.push(`Place ${direction} conf ${(confidence * 100).toFixed(0)}%`);
  return {
    phase: "decide",
    direction,
    confidence,
    shouldBet: true,
    reason: `Bet ${direction} ${(confidence * 100).toFixed(0)}%`,
    analysis,
    metrics,
  };
}

function scoreSignals({ current, startPrice, points, price, analysis, metrics }) {
  let up = 0;
  let down = 0;
  let votesUp = 0;
  let votesDown = 0;
  let quality = 0.5;

  if (current != null && startPrice != null && startPrice > 0) {
    const bps = ((current - startPrice) / startPrice) * 10_000;
    metrics.roundBps = roundN(bps, 2);
    if (Math.abs(bps) < 1.2) {
      analysis.push(`Start flat ${bps.toFixed(1)} bps`);
    } else {
      const w = clamp(Math.abs(bps) / 7, 0.4, 1.4);
      if (bps > 0) {
        up += w;
        votesUp++;
        analysis.push(`Start UP +${bps.toFixed(1)} bps`);
      } else {
        down += w;
        votesDown++;
        analysis.push(`Start DOWN ${bps.toFixed(1)} bps`);
      }
      quality += 0.1;
    }
  }

  const moms = [];
  for (const sec of [30, 60, 120, 180]) {
    const r = returnOver(points, sec);
    if (!r || Math.abs(r.bps) < 1) continue;
    moms.push(r.bps);
    const w = clamp(Math.abs(r.bps) / 10, 0.2, 0.85) * (sec <= 60 ? 1.1 : 0.9);
    if (r.bps > 0) {
      up += w;
      votesUp++;
      analysis.push(`Mom ${sec}s UP ${r.bps.toFixed(1)}`);
    } else {
      down += w;
      votesDown++;
      analysis.push(`Mom ${sec}s DOWN ${r.bps.toFixed(1)}`);
    }
  }
  if (moms.length >= 2) {
    const pos = moms.filter((x) => x > 0).length;
    const neg = moms.filter((x) => x < 0).length;
    if (pos === moms.length || neg === moms.length) {
      quality += 0.15;
      analysis.push("Mom aligned");
    } else if (pos && neg) {
      quality -= 0.08;
      analysis.push("Mom mixed");
    }
  }

  if (points.length >= 25) {
    const closes = points.map((p) => p.price);
    const f = emaLast(closes, 8);
    const s = emaLast(closes, 21);
    if (f != null && s != null && s > 0) {
      const spread = ((f - s) / s) * 10_000;
      metrics.emaBps = roundN(spread, 2);
      if (Math.abs(spread) >= 0.8) {
        const w = clamp(Math.abs(spread) / 8, 0.25, 0.8);
        if (spread > 0) {
          up += w;
          votesUp++;
          analysis.push(`EMA UP ${spread.toFixed(1)}`);
        } else {
          down += w;
          votesDown++;
          analysis.push(`EMA DOWN ${spread.toFixed(1)}`);
        }
      } else {
        analysis.push("EMA flat");
      }
    }
  }

  if (points.length >= 20) {
    const rsi = calcRsi(
      points.map((p) => p.price),
      14
    );
    metrics.rsi = roundN(rsi, 1);
    if (rsi != null) {
      if (rsi >= 65 && rsi < 78) {
        up += 0.35;
        votesUp++;
        analysis.push(`RSI up ${rsi.toFixed(0)}`);
      } else if (rsi <= 35 && rsi > 22) {
        down += 0.35;
        votesDown++;
        analysis.push(`RSI down ${rsi.toFixed(0)}`);
      } else if (rsi >= 78) {
        down += 0.25;
        votesDown++;
        analysis.push(`RSI high ${rsi.toFixed(0)}`);
      } else if (rsi <= 22) {
        up += 0.25;
        votesUp++;
        analysis.push(`RSI low ${rsi.toFixed(0)}`);
      } else {
        analysis.push(`RSI ${rsi?.toFixed(0)}`);
      }
    }
  }

  if (price?.sources && Array.isArray(price.sources) && startPrice != null) {
    const avail = price.sources.filter(
      (x) => x.available && num(x.price) != null
    );
    if (avail.length >= 3) {
      const ups = avail.filter((x) => x.price > startPrice).length;
      const downs = avail.length - ups;
      metrics.feeds = `${ups}U/${downs}D`;
      if (ups >= downs + 2) {
        up += 0.45;
        votesUp++;
        analysis.push(`Feeds UP ${ups}/${avail.length}`);
        quality += 0.05;
      } else if (downs >= ups + 2) {
        down += 0.45;
        votesDown++;
        analysis.push(`Feeds DOWN ${downs}/${avail.length}`);
        quality += 0.05;
      } else {
        analysis.push(`Feeds ${ups}/${downs}`);
      }
    }
  }

  const votes = votesUp + votesDown;
  const agreeRatio = votes === 0 ? 0 : Math.max(votesUp, votesDown) / votes;

  return {
    up,
    down,
    total: up + down,
    agreeRatio,
    quality: clamp(quality, 0, 1),
  };
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function clamp(x, a, b) {
  return Math.max(a, Math.min(b, x));
}
function roundN(x, n) {
  if (x == null || !Number.isFinite(Number(x))) return x;
  const p = 10 ** n;
  return Math.round(Number(x) * p) / p;
}
function lastPrice(history) {
  if (!history?.length) return null;
  return num(history[history.length - 1].price);
}
function normalizeHistory(history) {
  return (history || [])
    .map((p) => ({ t: Date.parse(p.timestamp), price: num(p.price) }))
    .filter((p) => Number.isFinite(p.t) && p.price != null)
    .sort((a, b) => a.t - b.t);
}
function returnOver(points, seconds) {
  if (points.length < 2) return null;
  const last = points[points.length - 1];
  const target = last.t - seconds * 1000;
  let base = null;
  for (let i = points.length - 1; i >= 0; i--) {
    if (points[i].t <= target) {
      base = points[i];
      break;
    }
  }
  if (!base) base = points[0];
  if (!base?.price) return null;
  return { bps: ((last.price - base.price) / base.price) * 10_000 };
}
function emaLast(values, period) {
  if (!values.length) return null;
  const k = 2 / (period + 1);
  let prev = values[0];
  for (let i = 1; i < values.length; i++) prev = values[i] * k + prev * (1 - k);
  return prev;
}
function calcRsi(closes, period = 14) {
  if (closes.length <= period) return null;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gains += d;
    else losses -= d;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}
