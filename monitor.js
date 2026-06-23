const express = require('express');
const router = express.Router();

// ─── In-memory ring buffer ────────────────────────────────────────────────────
const MAX_LOGS = 200;
const state = {
  requests: [],        // ring buffer of recent requests
  totalReqs: 0,
  totalErrors: 0,
  startTime: Date.now(),
};

// ─── Middleware: attach to app.use() before your routes ───────────────────────
function middleware(req, res, next) {
  const start = process.hrtime.bigint();

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    const entry = {
      method: req.method,
      path: req.route?.path ?? req.path,
      status: res.statusCode,
      ms: Math.round(durationMs),
      ts: Date.now(),
    };

    state.totalReqs++;
    if (entry.status >= 500) state.totalErrors++;

    state.requests.push(entry);
    if (state.requests.length > MAX_LOGS) state.requests.shift();

    // Console log with colour codes (remove if you prefer silent)
    const color = entry.status >= 500 ? '\x1b[31m' : entry.status >= 400 ? '\x1b[33m' : '\x1b[32m';
    const reset = '\x1b[0m';
    const slow = entry.ms > 500 ? ' ⚠ SLOW' : '';
    console.log(`${color}${entry.method} ${entry.path} ${entry.status} ${entry.ms}ms${slow}${reset}`);
  });

  next();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function getWindowReqs(windowMs = 60_000) {
  const cutoff = Date.now() - windowMs;
  return state.requests.filter(r => r.ts >= cutoff);
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.ceil(p * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function computeStats() {
  const window = getWindowReqs(60_000);
  const durations = window.map(r => r.ms).sort((a, b) => a - b);
  const errors = window.filter(r => r.status >= 500);

  const avg = durations.length ? Math.round(durations.reduce((s, v) => s + v, 0) / durations.length) : 0;
  const p95 = percentile(durations, 0.95);
  const p99 = percentile(durations, 0.99);

  const mem = process.memoryUsage();
  const uptimeSec = Math.floor((Date.now() - state.startTime) / 1000);

  // Top endpoints by request count (last 60s)
  const endpointMap = {};
  for (const r of window) {
    const key = `${r.method} ${r.path}`;
    if (!endpointMap[key]) endpointMap[key] = { count: 0, errors: 0 };
    endpointMap[key].count++;
    if (r.status >= 500) endpointMap[key].errors++;
  }
  const topEndpoints = Object.entries(endpointMap)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 10)
    .map(([route, d]) => ({ route, ...d }));

  return {
    uptime: uptimeSec,
    uptimeHuman: formatUptime(uptimeSec),
    requestsPerMin: window.length,
    totalRequests: state.totalReqs,
    totalErrors: state.totalErrors,
    errorRatePct: window.length ? +((errors.length / window.length) * 100).toFixed(2) : 0,
    responseTime: { avg, p95, p99 },
    memory: {
      heapUsedMB: +(mem.heapUsed / 1024 / 1024).toFixed(2),
      heapTotalMB: +(mem.heapTotal / 1024 / 1024).toFixed(2),
      rssMB: +(mem.rss / 1024 / 1024).toFixed(2),
      externalMB: +(mem.external / 1024 / 1024).toFixed(2),
    },
    recentRequests: state.requests.slice(-20).reverse(),
    topEndpoints,
    alerts: buildAlerts({ avg, errors, window, mem }),
  };
}

function buildAlerts({ avg, errors, window, mem }) {
  const a = [];
  const heapPct = mem.heapUsed / mem.heapTotal;
  const errRate = window.length ? errors.length / window.length : 0;

  if (errRate > 0.05)  a.push({ level: 'error',   msg: `High error rate: ${(errRate*100).toFixed(1)}% of requests failing` });
  if (avg > 500)       a.push({ level: 'warn',    msg: `Slow responses: avg ${avg}ms (threshold 500ms)` });
  if (heapPct > 0.85)  a.push({ level: 'error',   msg: `High heap usage: ${(heapPct*100).toFixed(0)}% of heap used` });
  if (heapPct > 0.65)  a.push({ level: 'warn',    msg: `Heap at ${(heapPct*100).toFixed(0)}% — watch for leaks` });
  if (!a.length)       a.push({ level: 'ok',      msg: 'All systems nominal' });

  return a;
}

function formatUptime(sec) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return [d && `${d}d`, h && `${h}h`, m && `${m}m`, `${s}s`].filter(Boolean).join(' ');
}

// ─── Routes: mount at any prefix, e.g. app.use('/monitor', monitor.router) ───

// GET /monitor/health — lightweight liveness probe (for Render, Railway, etc.)
router.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: formatUptime(Math.floor((Date.now() - state.startTime) / 1000)) });
});

// GET /monitor/metrics — full JSON metrics (use for dashboards, alerts, Grafana)
router.get('/metrics', (req, res) => {
  res.json(computeStats());
});

// GET /monitor/logs — recent raw request log
router.get('/logs', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, MAX_LOGS);
  const statusFilter = req.query.status ? parseInt(req.query.status) : null;
  let logs = state.requests.slice(-limit).reverse();
  if (statusFilter) logs = logs.filter(r => r.status === statusFilter);
  res.json({ count: logs.length, logs });
});

// ─── Exports ──────────────────────────────────────────────────────────────────
module.exports = { middleware, router };

/*
  ── SETUP IN YOUR app.js / index.js ──────────────────────────────────────────

  const express = require('express');
  const monitor = require('./monitor');

  const app = express();

  // 1. Attach middleware BEFORE your routes
  app.use(monitor.middleware);

  // 2. Mount the monitor dashboard routes
  app.use('/monitor', monitor.router);

  // 3. Your normal routes go here
  app.use('/api/users', userRouter);
  // ...

  app.listen(3000, () => console.log('Server running on port 3000'));

  ── ENDPOINTS YOU GET ─────────────────────────────────────────────────────────

  GET /monitor/health   → { status: 'ok', uptime: '2h 14m 7s' }
  GET /monitor/metrics  → full JSON: rpm, error rate, p95, memory, alerts, top endpoints
  GET /monitor/logs     → last 50 requests  (?limit=20&status=500 for filtering)

  ── OPTIONAL: ALERT WEBHOOK ───────────────────────────────────────────────────

  Add this block to computeStats() or run it on a setInterval to push alerts
  to Slack, Discord, or any webhook:

  async function notifySlack(msg) {
    const WEBHOOK = process.env.SLACK_WEBHOOK_URL;
    if (!WEBHOOK) return;
    await fetch(WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: `🚨 *Express Monitor*: ${msg}` }),
    });
  }

  // Call inside buildAlerts() for level === 'error':
  // notifySlack(alert.msg);
*/
