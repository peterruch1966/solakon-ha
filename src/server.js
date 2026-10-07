// Solakon Local: HTTP server, REST API and live updates (Server-Sent Events).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env, loadSettings, saveSettings, mergeSettings } from './config.js';
import { HomeAssistant } from './ha.js';
import { Solakon } from './solakon.js';
import { Controller, HARD_MAX_OUTPUT_W } from './controller.js';

const MAX_CHARGE_W = 1200;
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const log = {
  info: (...a) => console.log(new Date().toISOString(), 'INFO', ...a),
  warn: (...a) => console.warn(new Date().toISOString(), 'WARN', ...a),
  error: (...a) => console.error(new Date().toISOString(), 'ERROR', ...a),
};

let settings = loadSettings();
const getSettings = () => settings;

const ha = new HomeAssistant(env.haUrl, env.haToken, log);
const solakon = new Solakon(ha, getSettings, { deviceId: env.deviceId }, log);
const controller = new Controller(solakon, getSettings, log);

// Writable settings exposed in the UI, with their allowed ranges.
const NUMBER_LIMITS = {
  minimum_soc: [10, 100],
  maximum_soc: [0, 100],
  minimum_soc_ongrid: [10, 100],
  battery_max_charge_current: [0, 40],
  battery_max_discharge_current: [0, 40],
  grid_export_power_limit: [0, HARD_MAX_OUTPUT_W],
};
const SELECT_OPTIONS = {
  eps_output: ['0', '2', '3'],
};

// Energy counters (total_increasing) used for daily / monthly statistics.
const ENERGY_KEYS = [
  'pv_total_energy',
  'battery_total_charge_energy',
  'battery_total_discharge_energy',
  'grid_total_export_energy',
  'grid_total_import_energy',
];
const HISTORY_KEYS = ['total_pv_power', 'battery_power', 'active_power', 'battery_soc'];

function state() {
  return {
    ha: { connected: ha.connected, error: ha.lastError, url: env.haUrl },
    ...solakon.snapshot(),
    controller: controller.status,
    settings,
    serverTime: new Date().toISOString(),
  };
}

// --- Live updates -----------------------------------------------------------

const clients = new Set();
let pushTimer = null;
function schedulePush() {
  if (pushTimer) return;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    const data = `data: ${JSON.stringify(state())}\n\n`;
    for (const res of clients) res.write(data);
  }, 300);
}
solakon.on('update', schedulePush);
ha.on('connected', schedulePush);
ha.on('disconnected', schedulePush);

// --- Helpers -----------------------------------------------------------------

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1e6) throw new HttpError(413, 'Body too large');
  }
  try {
    return body ? JSON.parse(body) : {};
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

function num(v, [min, max], name) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new HttpError(400, `${name} must be between ${min} and ${max}`);
  }
  return n;
}

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

// Average history samples into fixed buckets so charts stay light.
function bucketize(points, startMs, endMs, bucketMs) {
  const out = [];
  let i = 0;
  let last = null;
  for (let t = startMs; t < endMs; t += bucketMs) {
    let sum = 0;
    let weight = 0;
    // Time-weighted average of a step function within [t, t + bucketMs).
    let cursor = t;
    while (i < points.length && points[i][0] < t + bucketMs) {
      const [pt, pv] = points[i];
      if (pt > cursor && last !== null) {
        sum += last * (pt - cursor);
        weight += pt - cursor;
      }
      cursor = Math.max(cursor, pt);
      last = pv;
      i++;
    }
    const bucketEnd = Math.min(t + bucketMs, Date.now());
    if (last !== null && bucketEnd > cursor) {
      sum += last * (bucketEnd - cursor);
      weight += bucketEnd - cursor;
    }
    if (t > Date.now()) break;
    out.push([t, weight ? Math.round((sum / weight) * 10) / 10 : null]);
  }
  return out;
}

// --- API handlers ------------------------------------------------------------

async function history(url) {
  const dayParam = url.searchParams.get('date'); // YYYY-MM-DD, defaults to today
  const start = dayParam ? new Date(`${dayParam}T00:00:00`) : startOfToday();
  if (Number.isNaN(start.getTime())) throw new HttpError(400, 'Invalid date');
  const end = new Date(start.getTime() + 24 * 3600e3);

  const ids = {};
  for (const k of HISTORY_KEYS) if (solakon.entityOf(k)) ids[k] = solakon.entityOf(k);
  if (settings.entities.gridPower) ids.grid = settings.entities.gridPower;
  if (!Object.keys(ids).length) return { start: start.getTime(), series: {} };

  const result = await ha.send({
    type: 'history/history_during_period',
    start_time: start.toISOString(),
    end_time: end.toISOString(),
    entity_ids: Object.values(ids),
    minimal_response: true,
    no_attributes: true,
    include_start_time_state: true,
    significant_changes_only: false,
  });

  const series = {};
  for (const [key, id] of Object.entries(ids)) {
    const pts = (result[id] || [])
      .map((p) => [Math.max(start.getTime(), (p.lu ?? p.lc) * 1000), Number(p.s)])
      .filter(([, v]) => Number.isFinite(v));
    if (key === 'grid' && settings.entities.gridPowerInverted) pts.forEach((p) => { p[1] = -p[1]; });
    series[key] = bucketize(pts, start.getTime(), end.getTime(), 5 * 60e3);
  }
  return { start: start.getTime(), series };
}

async function statistics(url) {
  const period = url.searchParams.get('period') || 'day'; // day | month | today
  const ids = {};
  for (const k of ENERGY_KEYS) if (solakon.entityOf(k)) ids[k] = solakon.entityOf(k);
  if (!Object.keys(ids).length) return { period, rows: [] };

  let start;
  let statPeriod = period;
  const now = new Date();
  if (period === 'today') {
    start = startOfToday();
    statPeriod = '5minute';
  } else if (period === 'month') {
    start = new Date(now.getFullYear() - 1, now.getMonth() + 1, 1);
  } else if (period === 'day') {
    start = startOfToday();
    start.setDate(start.getDate() - 29);
  } else {
    throw new HttpError(400, 'period must be today, day or month');
  }

  const result = await ha.send({
    type: 'recorder/statistics_during_period',
    start_time: start.toISOString(),
    statistic_ids: Object.values(ids),
    period: statPeriod,
    types: ['change'],
    units: { energy: 'kWh' },
  });

  if (period === 'today') {
    const totals = {};
    for (const [key, id] of Object.entries(ids)) {
      totals[key] = (result[id] || []).reduce((a, r) => a + (r.change || 0), 0);
    }
    return { period, totals };
  }

  const rows = new Map();
  for (const [key, id] of Object.entries(ids)) {
    for (const r of result[id] || []) {
      const t = typeof r.start === 'number' ? r.start : Date.parse(r.start);
      if (!rows.has(t)) rows.set(t, { start: t });
      rows.get(t)[key] = Math.round((r.change || 0) * 1000) / 1000;
    }
  }
  return { period, rows: [...rows.values()].sort((a, b) => a.start - b.start) };
}

async function powerSensors() {
  const states = await ha.send({ type: 'get_states' });
  return states
    .filter((s) => s.entity_id.startsWith('sensor.') && ['W', 'kW'].includes(s.attributes.unit_of_measurement))
    .map((s) => ({
      entityId: s.entity_id,
      name: s.attributes.friendly_name || s.entity_id,
      state: s.state,
      unit: s.attributes.unit_of_measurement,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function force(body) {
  const action = body.action;
  if (action === 'stop') {
    await solakon.selectOption('force_mode', '0');
    controller.pause(0);
    return;
  }
  if (action !== 'charge' && action !== 'discharge') throw new HttpError(400, 'Unknown action');
  const maxW = action === 'charge' ? MAX_CHARGE_W : HARD_MAX_OUTPUT_W;
  const watts = num(body.watts, [0, maxW], 'Power');
  const mins = num(body.minutes, [1, 1092], 'Duration');
  controller.pause(mins * 60e3);
  // Lower the power before switching into a discharge mode, never the other way around.
  await solakon.setNumber('force_power', watts);
  await solakon.setNumber('force_duration', mins);
  await solakon.selectOption('force_mode', action === 'charge' ? '3' : '1');
}

async function updateSettings(patch) {
  const next = mergeSettings(settings, patch);
  // Arrays are replaced, not merged.
  if (patch.control?.schedule) next.control.schedule = patch.control.schedule;
  const c = next.control;
  if (!['off', 'constant', 'zero'].includes(c.mode)) throw new HttpError(400, 'Invalid mode');
  c.maxOutputW = num(c.maxOutputW, [0, HARD_MAX_OUTPUT_W], 'Max output');
  c.constantW = num(c.constantW, [0, c.maxOutputW], 'Constant output');
  c.timeoutS = num(c.timeoutS, [30, 3600], 'Timeout');
  c.zero.intervalS = num(c.zero.intervalS, [2, 60], 'Interval');
  c.zero.smoothing = num(c.zero.smoothing, [0.05, 1], 'Smoothing');
  c.zero.deadbandW = num(c.zero.deadbandW, [0, 200], 'Deadband');
  c.zero.targetGridW = num(c.zero.targetGridW, [-200, 500], 'Grid target');
  for (const e of c.schedule) {
    if (!/^\d{1,2}:\d{2}$/.test(e.start) || !/^\d{1,2}:\d{2}$/.test(e.end)) throw new HttpError(400, 'Invalid schedule time');
    if (!['off', 'constant', 'zero'].includes(e.mode)) throw new HttpError(400, 'Invalid schedule mode');
    e.watts = num(e.watts ?? 0, [0, c.maxOutputW], 'Schedule power');
  }
  if (c.mode === 'zero' && !next.entities.gridPower) {
    throw new HttpError(400, 'Zero feed-in needs a smart meter entity (Settings → Smart meter).');
  }

  const entitiesChanged = JSON.stringify(next.entities) !== JSON.stringify(settings.entities)
    || JSON.stringify(next.overrides) !== JSON.stringify(settings.overrides);
  settings = next;
  saveSettings(settings);
  if (entitiesChanged) await solakon.resubscribe().catch((e) => log.error(e.message));
  await controller.kick();
  schedulePush();
}

async function api(req, res, url) {
  const route = `${req.method} ${url.pathname}`;
  switch (route) {
    case 'GET /api/state':
      return sendJson(res, 200, state());
    case 'GET /api/events': {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(`data: ${JSON.stringify(state())}\n\n`);
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => {
        clearInterval(ping);
        clients.delete(res);
      });
      return;
    }
    case 'GET /api/history':
      return sendJson(res, 200, await history(url));
    case 'GET /api/statistics':
      return sendJson(res, 200, await statistics(url));
    case 'GET /api/power-sensors':
      return sendJson(res, 200, await powerSensors());
    case 'POST /api/number': {
      const { key, value } = await readJson(req);
      if (!(key in NUMBER_LIMITS)) throw new HttpError(400, 'Setting not allowed');
      await solakon.setNumber(key, num(value, NUMBER_LIMITS[key], key));
      return sendJson(res, 200, { ok: true });
    }
    case 'POST /api/select': {
      const { key, option } = await readJson(req);
      if (!SELECT_OPTIONS[key]?.includes(String(option))) throw new HttpError(400, 'Option not allowed');
      await solakon.selectOption(key, option);
      return sendJson(res, 200, { ok: true });
    }
    case 'POST /api/force':
      await force(await readJson(req));
      schedulePush();
      return sendJson(res, 200, { ok: true });
    case 'PUT /api/settings':
      await updateSettings(await readJson(req));
      return sendJson(res, 200, { ok: true, settings });
    case 'POST /api/rediscover':
      await solakon.resubscribe();
      return sendJson(res, 200, { ok: true });
    default:
      throw new HttpError(404, 'Not found');
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
};

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) throw new HttpError(404, 'Not found');
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

function authorized(req) {
  if (!env.appPassword) return true;
  const m = /^Basic (.+)$/.exec(req.headers.authorization || '');
  if (!m) return false;
  const decoded = Buffer.from(m[1], 'base64').toString();
  return decoded.slice(decoded.indexOf(':') + 1) === env.appPassword;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/healthz') return sendJson(res, 200, { ok: true, ha: ha.connected });
  if (!authorized(req)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Solakon Local"' });
    return res.end('Authentication required');
  }
  try {
    if (url.pathname.startsWith('/api/')) await api(req, res, url);
    else serveStatic(res, url.pathname);
  } catch (err) {
    const status = err.status || 502;
    if (status >= 500) log.error(`${req.method} ${url.pathname}:`, err.message);
    if (!res.headersSent) sendJson(res, status, { error: err.message });
  }
});

server.listen(env.port, () => {
  log.info(`Solakon Local listening on :${env.port}, Home Assistant at ${env.haUrl}`);
  ha.start();
  controller.start();
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    controller.stop();
    ha.stop();
    server.close();
    process.exit(0);
  });
}
