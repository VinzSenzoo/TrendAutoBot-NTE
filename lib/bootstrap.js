import chalk from "chalk";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function randomDelayMs(minSec = 5, maxSec = 10) {
  const min = Math.min(minSec, maxSec) * 1000;
  const max = Math.max(minSec, maxSec) * 1000;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function delayBetween(log, label, isLast) {
  if (isLast) return;
  const ms = randomDelayMs(5, 10);
  const sec = (ms / 1000).toFixed(1);
  log(chalk.yellowBright(`Wait ${sec}s before next ${label}...`));
  await sleep(ms);
}

function isXFollowTask(task) {
  const v = String(task?.verificationType || "").toLowerCase();
  const t = String(task?.type || "").toLowerCase();
  const title = String(task?.title || "").toLowerCase();
  if (v === "x_follow" || v.includes("x_follow")) return true;
  if (t.includes("follow") && (t.includes("x") || v.startsWith("x_"))) return true;
  if (title.includes("follow") && (v.startsWith("x_") || t.includes("x_social"))) {
    if (v === "x_like" || v.includes("like") || v.includes("repost")) return false;
    if (v.includes("follow") || title.includes("follow ")) return true;
  }
  return false;
}

function isClaimed(status) {
  const s = String(status || "").toLowerCase();
  return ["claimed", "completed", "done", "rewarded"].includes(s);
}

function isActive(status) {
  const s = String(status || "").toLowerCase();
  return [
    "started",
    "submitted",
    "verified",
    "pending",
    "in_progress",
    "review",
  ].includes(s);
}

function wantsSubmit(task, errMsg = "") {
  if (task?.proofRequired) return true;
  const msg = String(errMsg || "").toLowerCase();
  if (msg.includes("use submit") || msg.includes("submit to verify")) return true;
  const v = String(task?.verificationType || "").toLowerCase();
  if (
    v.startsWith("x_") ||
    v.includes("like") ||
    v.includes("follow") ||
    v.includes("comment") ||
    v.includes("repost")
  ) {
    return true;
  }
  const provider = String(task?.verificationProvider || "").toLowerCase();
  if (provider === "x" || provider === "twitter") return true;
  return false;
}

async function safe(fn) {
  try {
    return { ok: true, data: await fn() };
  } catch (e) {
    return { ok: false, error: e, message: e.message || String(e) };
  }
}

export async function runBootstrap(client, log) {
  log(chalk.cyanBright("Starting Tasks & Trend Box..."));

  await runOnboardingClaim(client, log);
  await runFaucet(client, log);
  await runAutoTasks(client, log);
  await runTrendBox(client, log);

  log(chalk.greenBright("Tasks & Trend Box done. Starting auto predict..."));
}

async function runOnboardingClaim(client, log) {
  const res = await safe(() => client.getOnboarding());
  if (!res.ok) {
    log(chalk.yellowBright(`Onboarding skip: ${res.message}`));
    return;
  }
  const reward = res.data?.reward;
  if (reward?.claimable && !reward?.claimed) {
    log(chalk.yellowBright("Claiming onboarding reward..."));
    const claim = await safe(() => client.claimOnboarding());
    if (claim.ok) {
      log(chalk.greenBright("Onboarding reward claimed."));
    } else {
      log(chalk.yellowBright(`Onboarding claim failed: ${claim.message}`));
    }
  }
}

async function runFaucet(client, log) {
  const res = await safe(() => client.getFaucet());
  if (!res.ok) return;
  const d = res.data || {};
  const can =
    d.claimable === true ||
    d.available === true ||
    d.canClaim === true ||
    d.status === "available";
  if (!can) return;
  log(chalk.yellowBright("Claiming faucet..."));
  const claim = await safe(() => client.claimFaucet());
  if (claim.ok) {
    const amount = claim.data?.amount ?? claim.data?.rewardAmount ?? "";
    log(
      chalk.greenBright(
        amount !== "" ? `Faucet claimed +$${amount}` : "Faucet claimed."
      )
    );
  } else {
    log(chalk.yellowBright(`Faucet claim failed: ${claim.message}`));
  }
}

async function progressTask(client, task) {
  if (wantsSubmit(task)) {
    const submit = await safe(() => client.taskAction(task.id, "submit", {}));
    if (submit.ok) return { ok: true, via: "submit", data: submit.data };
    const verify = await safe(() => client.taskAction(task.id, "verify"));
    if (verify.ok) return { ok: true, via: "verify", data: verify.data };
    return {
      ok: false,
      message: submit.message || verify.message,
    };
  }

  const verify = await safe(() => client.taskAction(task.id, "verify"));
  if (verify.ok) return { ok: true, via: "verify", data: verify.data };

  if (wantsSubmit(task, verify.message)) {
    const submit = await safe(() => client.taskAction(task.id, "submit", {}));
    if (submit.ok) return { ok: true, via: "submit", data: submit.data };
    return { ok: false, message: submit.message || verify.message };
  }

  return { ok: false, message: verify.message };
}

async function runAutoTasks(client, log) {
  log(chalk.cyanBright("Checking tasks..."));

  const cooldown = await safe(() => client.getTaskCooldown());
  if (cooldown.ok && cooldown.data?.available === false) {
    log(
      chalk.yellowBright(
        `Task cooldown active until ${cooldown.data.nextStartAt || "later"}`
      )
    );
  }

  const tasksRes = await safe(() => client.getTasks());
  if (!tasksRes.ok) {
    log(chalk.redBright(`Load tasks failed: ${tasksRes.message}`));
    return;
  }
  const tasks = (tasksRes.data || []).filter(
    (t) =>
      String(t.status || "published").toLowerCase() === "published" && !t.isFull
  );

  const compRes = await safe(() => client.getMyTaskCompletions(50));
  const completions = compRes.ok ? compRes.data || [] : [];
  const byTask = new Map();
  for (const c of completions) {
    const tid = c.taskId || c.task?.id;
    if (tid) byTask.set(tid, c);
  }

  const pending = tasks
    .filter((t) => {
      if (isXFollowTask(t)) return false;
      const c = byTask.get(t.id);
      if (!c) return true;
      return !isClaimed(c.status);
    })
    .sort((a, b) => Number(b.priority || 0) - Number(a.priority || 0));

  const skippedFollow = tasks.filter((t) => isXFollowTask(t)).length;

  log(
    chalk.white(
      `Tasks found ${tasks.length} · done ${
        [...byTask.values()].filter((c) => isClaimed(c.status)).length
      } · pending ${pending.length}` +
        (skippedFollow ? ` · skip x_follow ${skippedFollow}` : "")
    )
  );

  if (skippedFollow) {
    log(chalk.yellowBright("Skip X_FOLLOW tasks (manual verify required)."));
  }

  if (!pending.length) {
    log(chalk.greenBright("No pending tasks."));
    return;
  }

  for (let i = 0; i < pending.length; i++) {
    const task = pending[i];
    const isLast = i === pending.length - 1;
    const title = task.title || task.id;
    log(chalk.magentaBright(`Task: ${title}`));

    const existing = byTask.get(task.id);
    const status = String(existing?.status || "").toLowerCase();

    if (!existing || status === "" || status === "started" || !isClaimed(status)) {
      if (!existing || !["submitted", "verified"].includes(status)) {
        if (!existing || status !== "started") {
          const start = await safe(() => client.taskAction(task.id, "start"));
          if (start.ok) {
            log(chalk.greenBright(`Started: ${title}`));
          } else {
            const msg = start.message || "";
            if (!/already|conflict|started/i.test(msg)) {
              log(chalk.yellowBright(`Start failed: ${msg}`));
            }
          }
        }
      }
    }

    if (task.trackingUrl) {
      const track = await safe(() => client.openTaskTracking(task.trackingUrl));
      if (track.ok) {
        log(chalk.cyanBright("Tracking opened."));
      }
    }

    const dwell = Number(task.minDwellSeconds || 0);
    if (dwell > 0) {
      await sleep(Math.min(dwell * 1000, 15000));
    } else {
      await sleep(800);
    }

    if (!["submitted", "verified"].includes(status)) {
      const prog = await progressTask(client, task);
      if (prog.ok) {
        log(
          chalk.greenBright(
            prog.via === "submit"
              ? `Submitted: ${title}`
              : `Verified: ${title}`
          )
        );
      } else {
        log(chalk.yellowBright(`Progress failed: ${prog.message}`));
        await delayBetween(log, "task", isLast);
        continue;
      }
    }

    const claim = await safe(() => client.taskAction(task.id, "claim"));
    if (claim.ok) {
      const reward =
        task.rewardBonusText ||
        `${task.rewardAmount || ""} ${task.rewardType || ""}`.trim();
      log(
        chalk.greenBright(
          reward ? `Claimed: ${title} · ${reward}` : `Claimed: ${title}`
        )
      );
    } else {
      log(chalk.yellowBright(`Claim failed: ${claim.message}`));
    }

    await delayBetween(log, "task", isLast);
  }
}

async function openOneBox(client, boxId, useTicket, log) {
  const label = useTicket ? "ticket" : "free 12h";
  log(chalk.yellowBright(`Opening Trend Box (${label})...`));
  const open = await safe(() => client.openBox(boxId, useTicket));
  if (!open.ok) {
    log(chalk.redBright(`Open box failed (${label}): ${open.message}`));
    return false;
  }
  const opening = open.data || {};
  const rewardType = opening.rewardType || opening.reward?.type || "REWARD";
  const rewardAmount =
    opening.rewardAmount ?? opening.reward?.amount ?? opening.amount ?? "?";
  log(
    chalk.greenBright(
      `Trend Box opened (${label}): ${rewardAmount} ${rewardType}`
    )
  );
  return true;
}

async function runTrendBox(client, log) {
  log(chalk.cyanBright("Checking Trend Box..."));

  const boxesRes = await safe(() => client.getBoxes());
  const boxes = boxesRes.ok ? boxesRes.data || [] : [];
  const box =
    boxes.find(
      (b) => b.boxType === "standard" || b.id === "trend_box_standard"
    ) || boxes[0];
  const boxId = box?.id || "trend_box_standard";

  const unlockRes = await safe(() => client.getBoxUnlock());
  if (unlockRes.ok) {
    const u = unlockRes.data || {};
    if (u.required && !u.unlocked) {
      log(
        chalk.yellowBright(
          "Trend Box locked. Connect X / follow official account on website first."
        )
      );
      return;
    }
  }

  let statusRes = await safe(() => client.getBoxStatus(boxId));
  if (!statusRes.ok) {
    log(chalk.redBright(`Box status failed: ${statusRes.message}`));
    return;
  }
  let st = statusRes.data || {};

  if (st.unlock?.required && st.unlock?.unlocked === false) {
    log(chalk.yellowBright("Trend Box not unlocked yet."));
    return;
  }

  const plan = [];
  if (st.available === true) {
    plan.push({ useTicket: false });
  } else {
    log(
      chalk.yellowBright(
        `Free Trend Box on cooldown. Next: ${st.nextOpenAt || "later"}`
      )
    );
  }

  let tickets = Number(st.boxTickets || 0);
  const canTicket = st.canPayWithTicket !== false;
  if (tickets > 0 && canTicket) {
    const maxTicketOpens = Math.min(tickets, 20);
    for (let i = 0; i < maxTicketOpens; i++) {
      plan.push({ useTicket: true });
    }
  }

  if (!plan.length) {
    log(chalk.yellowBright("No free open and no box tickets left."));
    return;
  }

  let opened = 0;
  for (let i = 0; i < plan.length; i++) {
    const isLast = i === plan.length - 1;
    const item = plan[i];
    const ok = await openOneBox(client, boxId, item.useTicket, log);
    if (!ok) {
      if (item.useTicket) break;
      continue;
    }
    opened += 1;
    await delayBetween(log, "box", isLast);
  }

  if (opened > 0) {
    log(chalk.greenBright(`Trend Box opens done: ${opened}`));
  }
}
