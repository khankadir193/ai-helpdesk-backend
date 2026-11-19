/**
 * Temporary headless-Chrome verification for the dashboard UI.
 * Not part of the application; deleted after the check.
 *
 * Run from the backend folder: node scripts/_ui_dashboard_check.mjs
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import database from "../src/config/database.js";

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const APP = "http://localhost:5173";
const API = "http://localhost:3000/api/v1";
const DEBUG_PORT = 9333;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let passed = 0;
let failed = 0;
function check(label, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`PASS ${label}`);
  } else {
    failed += 1;
    console.log(`FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function formatDuration(hours) {
  if (hours === null || hours === undefined) return "–";
  const value = Number(hours);
  if (!Number.isFinite(value) || value < 0) return "–";
  const totalMinutes = Math.round(value * 60);
  if (totalMinutes === 0) return "0m";
  const days = Math.floor(totalMinutes / 1440);
  const remainder = totalMinutes % 1440;
  const wholeHours = Math.floor(remainder / 60);
  const minutes = remainder % 60;
  if (days > 0) return wholeHours > 0 ? `${days}d ${wholeHours}h` : `${days}d`;
  if (wholeHours > 0) {
    return minutes > 0
      ? `${wholeHours}h ${String(minutes).padStart(2, "0")}m`
      : `${wholeHours}h`;
  }
  return `${minutes}m`;
}

class CDP {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
    this.ws = null;
  }

  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = () => reject(new Error("CDP WebSocket failed"));
    });
    this.ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
        return;
      }
      for (const handler of this.handlers.get(message.method) ?? []) {
        handler(message.params);
      }
    };
    this.ws.onclose = (event) => {
      console.log(`CDP socket closed (${event.code}) ${event.reason}`);
      for (const pending of this.pending.values()) {
        pending.reject(new Error("CDP socket closed"));
      }
      this.pending.clear();
    };
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, 30000);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  on(event, handler) {
    if (!this.handlers.has(event)) this.handlers.set(event, []);
    this.handlers.get(event).push(handler);
  }

  close() {
    this.ws?.close();
  }
}

const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "hd-dashboard-ui-"));
const downloadDir = path.join(profileDir, "downloads");
fs.mkdirSync(downloadDir, { recursive: true });
const chromeLog = fs.createWriteStream(path.join(profileDir, "chrome-stderr.log"));

const chrome = spawn(
  CHROME,
  [
    `--remote-debugging-port=${DEBUG_PORT}`,
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    `--user-data-dir=${profileDir}`,
    "about:blank",
  ],
  { stdio: ["ignore", "ignore", chromeLog] },
);

let cdp;
let tempUserId = null;
const consoleErrors = [];

async function waitForHttp(url, timeout = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const res = await fetch(url);
      if (res.ok) return res;
    } catch {
      // Chrome not ready yet
    }
    await sleep(200);
  }
  throw new Error(`timeout waiting for ${url}`);
}

async function evaluate(expression, { awaitPromise = true } = {}) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise,
    returnByValue: true,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text,
    );
  }
  return result.result.value;
}

async function waitFor(expression, timeout = 20000, label = expression) {
  const start = Date.now();
  let lastError = null;
  while (Date.now() - start < timeout) {
    try {
      const value = await evaluate(expression);
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(200);
  }
  throw new Error(`timeout waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`);
}

async function apiLogin(email, password) {
  const res = await fetch(`${API}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`API login failed: ${email} ${res.status}`);
  const match = /helpdesk\.sid=([^;]+)/.exec(res.headers.get("set-cookie") ?? "");
  if (!match) throw new Error("session cookie missing");
  return match[1];
}

async function setSessionCookie(value) {
  await cdp.send("Network.clearBrowserCookies");
  await cdp.send("Network.setCookie", {
    name: "helpdesk.sid",
    value,
    domain: "localhost",
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
  });
}

async function openDashboard() {
  console.log("  · navigating to dashboard");
  await cdp.send("Page.navigate", { url: `${APP}/` });
  await waitFor(
    `document.readyState === "complete" && (document.querySelector('.kpi-grid') || document.querySelector('input[type="email"]') || document.querySelector('[class*="stateTitle"]'))`,
    30000,
    "dashboard or sign-in page",
  );
  await waitFor(
    `document.querySelector('.kpi-grid') || document.querySelector('input[type="email"]')`,
    20000,
    "dashboard or sign-in form",
  );
  const onSignIn = await evaluate(`!!document.querySelector('input[type="email"]')`);
  if (onSignIn) throw new Error("session cookie was not accepted; landed on sign-in");
  await waitFor(`document.querySelector('.kpi-grid')`, 20000, "KPI grid");
  await sleep(400);
  console.log("  · dashboard rendered");
}

async function dashboardPayload() {
  const payload = await evaluate(`(async () => {
    const res = await fetch('${API}/dashboard?limit=4', { credentials: 'include' });
    return { status: res.status, body: await res.json() };
  })()`);
  return payload;
}

async function currentUser() {
  return evaluate(`(async () => {
    const res = await fetch('${API}/auth/me', { credentials: 'include' });
    if (!res.ok) return null;
    return res.json();
  })()`);
}

async function snapshot() {
  return evaluate(`(() => {
    const text = (selector) => document.querySelector(selector)?.innerText ?? null;
    return {
      greeting: text('.greeting-row__title'),
      subtext: text('.greeting-row__subtext'),
      kpis: [...document.querySelectorAll('.kpi-card')].map((card) => ({
        label: card.querySelector('.kpi-card__label')?.textContent ?? '',
        value: card.querySelector('.kpi-card__value')?.textContent ?? '',
        footer: card.querySelector('.kpi-card__comparison')?.textContent ?? '',
        trend: card.querySelector('.kpi-card__trend')?.textContent ?? null,
      })),
      barCount: document.querySelectorAll('.tv-bar').length,
      chartEmpty: text('.tv-empty'),
      chartTitle: text('.tv-card__title'),
      donutCenter: text('.priority-donut__center-num'),
      donutEmpty: text('.priority-donut__empty'),
      donutLegend: [...document.querySelectorAll('.priority-donut__legend-row')].map((row) => row.innerText),
      activityRows: [...document.querySelectorAll('.activity-card__list > *')].map((row) => row.innerText),
      activityEmpty: text('.activity-card__empty'),
      teamRows: [...document.querySelectorAll('.team-table__row')].map((row) => row.innerText),
      teamEmpty: text('.team-card__empty'),
      teamTitle: text('.team-card__title'),
      exportButton: !!document.querySelector('.btn-export'),
      bodyOverflow:
        document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  })()`);
}

async function roleCheck(role, email, password, label = role) {
  console.log(`\n=== UI ${label} ===`);
  console.log("  · logging in through the API");
  const cookie = await apiLogin(email, password);
  console.log("  · setting the session cookie");
  await setSessionCookie(cookie);
  await openDashboard();

  const me = await currentUser();
  const { status, body } = await dashboardPayload();
  console.log("  · dashboard payload received");
  check(`${label} dashboard API 200`, status === 200, String(status));
  const dashboard = body?.data?.dashboard;
  check(`${label} API role matches account`, dashboard?.role === role, dashboard?.role);
  const userName = me?.data?.user?.name ?? "";
  const firstName = String(userName).split(" ")[0];
  const snap = await snapshot();
  check(
    `${label} greeting shows the signed-in user`,
    typeof snap.greeting === "string" && firstName && snap.greeting.endsWith(firstName),
    `${snap.greeting} vs ${firstName}`,
  );
  check(`${label} role subtext rendered`, Boolean(snap.subtext));

  const total = dashboard.total_tickets;
  const statusCounts = dashboard.status_counts;
  const expectedKpis =
    role === "AGENT"
      ? [
          ["Open tickets", String(statusCounts.OPEN)],
          ["In progress", String(statusCounts.IN_PROGRESS)],
          ["Resolved", String(statusCounts.RESOLVED)],
          ["Closed tickets", String(statusCounts.CLOSED)],
          ["Avg. first response", formatDuration(dashboard.avg_first_response_hours)],
          ["Avg. resolution", formatDuration(dashboard.avg_resolution_hours)],
        ]
      : [
          ["Open tickets", String(statusCounts.OPEN)],
          ["Unassigned", String(dashboard.unassigned_count)],
          ["In progress", String(statusCounts.IN_PROGRESS)],
          ["Resolved", String(statusCounts.RESOLVED)],
          ["Avg. first response", formatDuration(dashboard.avg_first_response_hours)],
          ["Avg. resolution", formatDuration(dashboard.avg_resolution_hours)],
        ];
  check(
    `${role} KPI labels`,
    JSON.stringify(snap.kpis.map((card) => card.label)) ===
      JSON.stringify(expectedKpis.map(([label]) => label)),
    JSON.stringify(snap.kpis.map((card) => card.label)),
  );
  check(
    `${role} KPI values match the API`,
    JSON.stringify(snap.kpis.map((card) => card.value)) ===
      JSON.stringify(expectedKpis.map(([, value]) => value)),
    JSON.stringify(snap.kpis.map((card) => card.value)),
  );
  check(
    `${role} KPI cards show no fabricated trends`,
    snap.kpis.every((card) => card.trend === null),
  );

  const volume = dashboard.ticket_volume;
  const volumeTotal = volume.total_created + volume.total_resolved;
  if (volumeTotal === 0) {
    check(`${role} chart shows the empty state`, Boolean(snap.chartEmpty));
    check(`${role} chart draws no bars`, snap.barCount === 0);
  } else {
    check(`${role} chart draws created+resolved bars`, snap.barCount === 14, String(snap.barCount));
    check(`${role} chart has no empty-state text`, !snap.chartEmpty);
  }

  if (total === 0) {
    check(`${role} donut shows the empty state`, Boolean(snap.donutEmpty));
    check(`${role} recent list shows the empty state`, Boolean(snap.activityEmpty));
  } else {
    check(`${role} donut center equals total tickets`, snap.donutCenter === String(total), `${snap.donutCenter} vs ${total}`);
    check(`${role} donut legend has four priorities`, snap.donutLegend.length === 4, String(snap.donutLegend.length));
    for (const [key, label] of [["URGENT", "Urgent"], ["HIGH", "High"], ["MEDIUM", "Medium"], ["LOW", "Low"]]) {
      const row = snap.donutLegend.find((entry) => entry.includes(label));
      check(
        `${role} donut ${label} count = ${dashboard.priority_counts[key]}`,
        Boolean(row) && row.includes(`${dashboard.priority_counts[key]} ·`),
        row,
      );
    }

    const expectedRecent = Math.min(4, dashboard.recent_tickets.length);
    check(`${role} recent list rows`, snap.activityRows.length === expectedRecent, String(snap.activityRows.length));
    const firstRecent = dashboard.recent_tickets[0];
    check(
      `${role} newest recent ticket shown first`,
      snap.activityRows[0]?.includes(String(firstRecent.id)) &&
        snap.activityRows[0]?.includes("created"),
      snap.activityRows[0],
    );
    check(
      `${role} latest recent ticket title shown`,
      snap.activityRows[0]?.includes(firstRecent.title.slice(0, 20)),
      snap.activityRows[0],
    );
  }

  if (role === "ADMIN") {
    const expectedTeam = Math.min(5, dashboard.agent_workload.length);
    check(`${role} team table present`, snap.teamRows.length === expectedTeam, String(snap.teamRows.length));
    const topAgent = dashboard.agent_workload[0];
    check(
      `${role} top agent row matches the API`,
      snap.teamRows[0]?.includes(topAgent.agent_name) &&
        snap.teamRows[0]?.includes(
          String((topAgent.resolved ?? 0) + (topAgent.closed ?? 0)),
        ),
      snap.teamRows[0],
    );
  } else {
    check(`${role} has no team table`, snap.teamRows.length === 0 && !snap.teamTitle);
  }

  check(`${role} export control present`, snap.exportButton);
  check(`${role} page has no horizontal overflow at 1440`, snap.bodyOverflow <= 1, String(snap.bodyOverflow));

  return { dashboard, me, snap };
}

async function exportCheck(role) {
  const before = new Set(fs.readdirSync(downloadDir));
  await evaluate(`document.querySelector('.btn-export').click()`);
  let file = null;
  const start = Date.now();
  while (Date.now() - start < 10000) {
    const files = fs
      .readdirSync(downloadDir)
      .filter((entry) => !before.has(entry) && entry.endsWith(".csv"));
    if (files.length > 0) {
      file = path.join(downloadDir, files[0]);
      break;
    }
    await sleep(200);
  }
  check(`${role} CSV export downloads`, Boolean(file), "no file appeared");
  if (file) {
    const csv = fs.readFileSync(file, "utf8");
    check(`${role} CSV has a header row`, csv.startsWith("Section,Metric,Value,Details"));
    check(`${role} CSV contains dashboard totals`, csv.includes("Total tickets"));
    check(`${role} CSV does not contain NaN or undefined`, !/NaN|undefined/.test(csv));
  }
}

async function responsiveCheck(role) {
  for (const width of [1440, 1024, 768, 390]) {
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await sleep(350);
    const metrics = await evaluate(`(() => {
      const main = document.querySelector('main.dashboard-content');
      const overflow = [...main.querySelectorAll('*')]
        .filter((el) => {
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && (rect.right > window.innerWidth + 1 || rect.left < -1);
        })
        .slice(0, 5)
        .map((el) => el.className || el.tagName);
      return {
        innerWidth: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        overflow,
        kpiColumns: getComputedStyle(document.querySelector('.kpi-grid'))
          .gridTemplateColumns.split(' ').length,
      };
    })()`);
    check(
      `${role} no horizontal overflow at ${width}px`,
      metrics.scrollWidth <= metrics.innerWidth + 1 && metrics.overflow.length === 0,
      JSON.stringify(metrics),
    );
    const expectedColumns = width <= 480 ? 1 : width <= 767 ? 2 : width <= 1279 ? 3 : 6;
    check(
      `${role} KPI grid columns at ${width}px`,
      metrics.kpiColumns === expectedColumns,
      `${metrics.kpiColumns} vs ${expectedColumns}`,
    );
  }
  await cdp.send("Emulation.clearDeviceMetricsOverride");
}

async function errorStateCheck() {
  console.log("\n=== UI dashboard API failure ===");
  await cdp.send("Network.setBlockedURLs", {
    urls: ["*://localhost:3000/api/v1/dashboard*"],
  });
  await cdp.send("Page.reload", { ignoreCache: true });
  await waitFor(
    `document.querySelector('[class*="stateTitle"]') || document.querySelector('.kpi-grid')`,
    30000,
    "error state or dashboard",
  );
  const failed = await evaluate(`(() => ({
    title: document.querySelector('[class*="stateTitle"]')?.textContent ?? null,
    text: document.querySelector('[class*="stateText"]')?.textContent ?? null,
    retry: [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Retry'),
    hasGrid: !!document.querySelector('.kpi-grid'),
  }))()`);
  check("API failure shows an error title", failed.title === "Something went wrong", failed.title);
  check("API failure shows a retry action", failed.retry);
  check("API failure does not render stale KPI cards", !failed.hasGrid);

  await cdp.send("Network.setBlockedURLs", { urls: [] });
  await evaluate(
    `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Retry')?.click()`,
  );
  await waitFor(`document.querySelector('.kpi-grid')`, 20000, "dashboard after Retry");
  check("Retry recovers the dashboard", true);
}

// ── Run ──────────────────────────────────────────────────────────────────────
try {
  console.log("launching Chrome...");
  await waitForHttp(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
  console.log("Chrome ready, creating target");
  const target = await (
    await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?about:blank`, {
      method: "PUT",
    })
  ).json();
  cdp = new CDP(target.webSocketDebuggerUrl);
  await cdp.connect();
  console.log("CDP connected");
  cdp.on("Runtime.exceptionThrown", (params) => {
    consoleErrors.push(params.exceptionDetails?.text ?? "exception");
  });
  cdp.on("Log.entryAdded", (params) => {
    const text = params.entry?.text ?? "";
    if (
      params.entry?.level === "error" &&
      !/ERR_BLOCKED_BY_CLIENT|Failed to load resource/.test(text)
    ) {
      consoleErrors.push(text);
    }
  });
  await Promise.all([
    cdp.send("Page.enable"),
    cdp.send("Runtime.enable"),
    cdp.send("Network.enable"),
    cdp.send("Log.enable"),
  ]);
  await cdp.send("Page.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: downloadDir,
  });

  await roleCheck(
    "ADMIN",
    "admin@example.com",
    "khanAdmin@543",
  );
  await exportCheck("ADMIN");
  await responsiveCheck("ADMIN");

  await roleCheck("AGENT", "agent@example.com", "khanAgent@543");
  await responsiveCheck("AGENT");

  await roleCheck(
    "CUSTOMER",
    "customer@example.com",
    "khanCustomer@543",
  );
  await responsiveCheck("CUSTOMER");

  // Temporary zero-data customer with the same password hash as the demo customer.
  const { rows: passwordRows } = await database.query(
    "SELECT password_hash FROM users WHERE lower(email) = 'customer@example.com'",
  );
  const zeroEmail = `zero_ui_${Date.now()}@example.com`;
  const { rows: zeroRows } = await database.query(
    `INSERT INTO users (name, email, password_hash, role)
     VALUES ('Zero UI Customer', $1, $2, 'CUSTOMER')
     RETURNING id`,
    [zeroEmail, passwordRows[0].password_hash],
  );
  tempUserId = zeroRows[0].id;

  await roleCheck(
    "CUSTOMER",
    zeroEmail,
    "khanCustomer@543",
    "CUSTOMER (zero data)",
  );
  await exportCheck("ZERO");
  await responsiveCheck("ZERO");

  await errorStateCheck();

  console.log("\n=== Console errors ===");
  if (consoleErrors.length === 0) {
    console.log("PASS no browser console errors or uncaught exceptions");
    passed += 1;
  } else {
    failed += 1;
    console.log(`FAIL ${consoleErrors.length} browser error(s):`);
    for (const error of consoleErrors.slice(0, 10)) console.log(`  ${error}`);
  }
} finally {
  if (tempUserId !== null) {
    await database.query("DELETE FROM users WHERE id = $1", [tempUserId]);
    console.log("temporary zero-data UI customer removed");
  }
  try {
    await cdp?.send("Browser.close");
  } catch {
    // already closed
  }
  cdp?.close();
  chrome.kill();
  await sleep(1000);
  try {
    fs.rmSync(profileDir, { recursive: true, force: true });
  } catch {
    // Windows may keep a handle briefly; the temp folder is safe to leave.
  }
  await database.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed === 0 ? 0 : 1;
}
