import { STRINGS } from './i18n.js';
import { lineChart, barChart } from './chart.js';

// The panel's shadow root and the Home Assistant object, set by mount().
let root = null;
let hass = null;
const $ = (sel) => root.querySelector(sel);
const $$ = (sel) => [...root.querySelectorAll(sel)];
const active = () => root.activeElement;

let S = null; // latest state from the integration
let subError = null; // why the live subscription failed, if it did
let unsubscribe = null;
let listeners = null; // AbortController of all event listeners, aborted on unmount
let todayTimer = null;
let langPref = storage('solakon.lang') || ''; // '' = follow the Home Assistant language
let lang = 'de';
let dark = null;
let view = 'home';
let ctlDraft = null; // unsaved edits of the control settings
let today = null;
let dayOffset = 0;
let energyPeriod = 'day';
let energyTable = false;
let gridTable = false;

// --- helpers -----------------------------------------------------------------

const t = (k) => STRINGS[lang][k] ?? STRINGS.de[k] ?? k;
const nf = (digits = 0) => new Intl.NumberFormat(lang, { minimumFractionDigits: digits, maximumFractionDigits: digits });
const v = (key) => S?.values?.[key] ?? null;
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const css = (name) => getComputedStyle(root.host).getPropertyValue(name).trim();
const ex = (key) => S?.extra?.[key] ?? null; // values of the extra PV inverter / grid meter
const pv2Name = () => S?.extra?.devices?.pv?.name || t('series.pv2');
const kwh = (x) => (isNum(x) ? `${nf(2).format(x)} kWh` : '–');

function fmtW(w) {
  if (!isNum(w)) return '–';
  return Math.abs(w) >= 1000 ? `${nf(2).format(w / 1000)} kW` : `${nf(0).format(w)} W`;
}
function fmtU(x, unit, digits = 1) {
  return isNum(x) ? `${nf(digits).format(x)} ${unit}` : (x ?? '–');
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
// localStorage can be unavailable (private mode, blocked site data).
function storage(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    if (value === '') localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch { /* ignore */ }
  return null;
}

function toast(msg, err = false) {
  if (!root) return; // unmounted while a command was running
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast show${err ? ' err' : ''}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.className = 'toast'; }, err ? 5000 : 2200);
}

// Command of the Solakon Local integration over the Home Assistant WebSocket.
const ws = (type, data = {}) => hass.callWS({ type: `solakon_local/${type}`, ...data });

async function act(fn, okMsg) {
  try {
    await fn();
    if (okMsg) toast(okMsg);
  } catch (err) {
    toast(err?.message || String(err), true);
  }
}

// --- i18n & theme -------------------------------------------------------------

function applyI18n() {
  const haLang = hass?.locale?.language || hass?.language || '';
  lang = langPref || (haLang.startsWith('de') ? 'de' : 'en');
  root.host.lang = lang;
  for (const el of $$('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  $('#lang').value = langPref;
}

// The panel follows the light/dark mode of the Home Assistant theme.
function applyTheme() {
  const d = !!hass?.themes?.darkMode;
  if (d === dark) return false;
  dark = d;
  root.host.dataset.theme = d ? 'dark' : 'light';
  return true;
}

// --- navigation ---------------------------------------------------------------

function show(name) {
  view = name;
  for (const b of $$('nav.tabs button')) b.classList.toggle('on', b.dataset.view === name);
  for (const s of $$('.view')) s.classList.toggle('active', s.id === `view-${name}`);
  if (name === 'stats') loadStats();
  if (name === 'settings') { loadMeterOptions(); loadDeviceSensors(); }
  render();
  $('#content').scrollTop = 0;
}

// --- rendering ----------------------------------------------------------------

function render() {
  renderHeader();
  if (!S) return;
  if (view === 'home') renderHome();
  if (view === 'control') renderControl();
  if (view === 'device') renderDevice();
  if (view === 'settings') renderSettings();
}

function renderHeader() {
  $('#title').textContent = S?.device?.name || 'Solakon ONE';
  const banners = [];
  if (hass && hass.connected === false) banners.push(`<div class="banner error"><b>${esc(t('err.ha'))}</b></div>`);
  else if (subError) banners.push(`<div class="banner error"><b>${esc(t('err.notLoaded'))}</b><br><span class="small">${esc(subError)}</span></div>`);
  else if (S?.discoveryError) banners.push(`<div class="banner error">${esc(t('err.noEntities'))}<br><span class="small">${esc(S.discoveryError)}</span></div>`);
  if (S?.controller.error && S.controller.mode !== 'off') banners.push(`<div class="banner info">${esc(S.controller.error)}</div>`);
  const html = banners.join('');
  // Only touch the DOM when something changed: setHass() calls this on every state change in HA.
  if ($('#banners').innerHTML !== html) $('#banners').innerHTML = html;
}

function controllerLabel() {
  const c = S.controller;
  let txt = t(`mode.${c.mode}`);
  if (c.mode !== 'off' && c.mode !== 'paused' && isNum(c.targetW)) txt += ` · ${fmtW(c.targetW)}`;
  if (c.source === 'schedule' && c.mode !== 'paused') txt += ` (${t('src.schedule')})`;
  return txt;
}

function renderHome() {
  const soc = v('battery_soc');
  const bp = v('battery_power'); // >0 discharging, <0 charging
  $('#soc').textContent = isNum(soc) ? `${nf(0).format(soc)}%` : '–';
  const circ = 2 * Math.PI * 52;
  $('#soc-arc').setAttribute('stroke-dasharray', `${isNum(soc) ? (soc / 100) * circ : 0} ${circ}`);
  $('#bat-state').textContent = !isNum(bp) ? '–' : bp < -5 ? t('bat.charging') : bp > 5 ? t('bat.discharging') : t('bat.idle');
  $('#bat-power').textContent = isNum(bp) ? fmtW(Math.abs(bp)) : '–';
  const cap = v('bms1_design_energy');
  $('#bat-stored').textContent = isNum(cap) && isNum(soc)
    ? `${nf(2).format((cap * soc) / 100 / 1000)} / ${nf(2).format(cap / 1000)} kWh` : '–';
  $('#bat-temp').textContent = fmtU(v('bms1_max_temp'), '°C');
  $('#ctl-chip').textContent = controllerLabel();
  renderFlow();
  renderToday();
}

const ICONS = {
  sun: 'M0,-6a6,6 0 1,0 0.01,0M0,-12v2.5M0,9.5V12M-12,0h2.5M9.5,0H12M-8.5,-8.5l1.8,1.8M6.7,6.7l1.8,1.8M-8.5,8.5l1.8,-1.8M6.7,-6.7l1.8,-1.8',
  battery: 'M-6,-9h12v19h-12zM-2.5,-11.5h5', // the fill level is drawn separately
  device: 'M-9,-10h18v20h-18zM-5,-5h10M-5,0h10M-5,5h4',
  home: 'M-10,0l10,-9l10,9M-7,-2.5v11h14v-11',
  grid: 'M-5,11l5,-21l5,21M-8,-5h16M-6,2h12M-2.5,-10l2.5,-2l2.5,2',
  wallbox: 'M-7,-11h10v22h-10zM-4,-7h4M-2,-3l-2,4h3l-2,4M3,-5h3v10a2,2 0 0,0 4,0v-4',
  heatpump: 'M-11,-8h22v16h-22zM-4,-5a5,5 0 1,0 0.01,0M-4,-5v10M-9,0h10M5,-4h3M5,0h3M5,4h3',
};

// Battery fill level inside the battery icon, from the state of charge.
function batteryLevel(soc) {
  if (!isNum(soc)) return '';
  const h = (Math.min(100, Math.max(0, soc)) / 100) * 15;
  return `<rect class="level" x="-3.5" y="${7.5 - h}" width="7" height="${h}" rx="1"/>`;
}

function renderFlow() {
  const svg = $('#flow');
  const pv = v('total_pv_power');
  const bp = v('battery_power');
  const out = v('active_power');
  const pv2 = ex('pvPower');
  const grid = S.gridPower;
  const hasMeter = isNum(grid);
  const hasPv2 = isNum(pv2);
  const wb = ex('wallboxPower');
  const hasWallbox = isNum(wb);
  const hp = ex('heatpumpPower');
  const hasHeatpump = isNum(hp);
  // The heat pump stays visible while idle, even if its sensor is unavailable then.
  const showHeatpump = hasHeatpump || !!S.extra?.entities?.heatpumpPower;
  // The wallbox and heat pump are behind the grid meter, so they are taken out of the home consumption.
  const home = hasMeter && isNum(out)
    ? out + grid + (hasPv2 ? pv2 : 0) - (hasWallbox ? wb : 0) - (hasHeatpump ? hp : 0) : null;

  const N = {
    solar: [152, 82], battery: [52, 180], device: [152, 180], home: [252, 180], grid: [352, 180], pv2: [152, 282],
    wallbox: [252, 82], heatpump: [252, 282],
  };
  const lines = [
    // [from, to, watts (positive = flows from -> to)]
    ['solar', 'device', pv, css('--s-pv')],
    ['device', 'battery', isNum(bp) ? -bp : null, css('--s-battery')],
    ['device', 'home', out, css('--s-output')],
  ];
  lines.push(['grid', 'home', hasMeter ? grid : null, css('--s-grid')]);
  if (hasPv2) lines.push(['pv2', 'home', pv2, css('--s-pv2')]);
  if (hasWallbox) lines.push(['home', 'wallbox', wb, css('--s-wallbox')]);
  if (showHeatpump) lines.push(['home', 'heatpump', hp, css('--s-heatpump')]);

  let html = '';
  for (const [a, b, w, color] of lines) {
    const [x1, y1] = N[a];
    const [x2, y2] = N[b];
    const active = isNum(w) && Math.abs(w) > 5;
    html += `<path class="line${active ? ' active' : ''}${active && w < 0 ? ' rev' : ''}" d="M${x1},${y1}L${x2},${y2}" ${active ? `style="stroke:${color}"` : ''}/>`;
  }
  // Labels sit on the side of each node that has no connector.
  const LABEL_ABOVE = { solar: true, wallbox: true };
  const node = (key, icon, label, value, color) => {
    const [x, y] = N[key];
    const on = isNum(value) && Math.abs(value) > 5;
    const above = LABEL_ABOVE[key];
    const showValue = key !== 'device';
    const pw = esc(fmtW(isNum(value) ? Math.abs(value) : null));
    return `<g class="node ${key}${on ? ' on' : ''}" transform="translate(${x},${y})">
      <circle r="30" ${on ? `style="stroke:${color}"` : ''}/>
      <path class="icon" d="${ICONS[icon]}"/>
      ${key === 'battery' ? batteryLevel(v('battery_soc')) : ''}
      <text class="lbl" y="${above ? (showValue ? -57 : -40) : 46}">${esc(label)}</text>
      ${showValue ? `<text class="pw" y="${above ? -40 : 63}">${pw}</text>` : ''}
    </g>`;
  };
  html += node('solar', 'sun', t('flow.solar'), pv, css('--s-pv'));
  html += node('battery', 'battery', `${t('flow.battery')}${isNum(v('battery_soc')) ? ` ${nf(0).format(v('battery_soc'))}%` : ''}`, bp, css('--s-battery'));
  html += node('device', 'device', t('flow.device'), null, '');
  html += node('home', 'home', hasMeter ? t('flow.home') : t('flow.output'), hasMeter ? home : out, css('--s-output'));
  html += node('grid', 'grid', hasMeter && grid < -5 ? t('flow.gridOut') : t('flow.grid'), hasMeter ? grid : null, css('--s-grid'));
  if (hasPv2) html += node('pv2', 'sun', pv2Name().slice(0, 24), pv2, css('--s-pv2'));
  if (hasWallbox) html += node('wallbox', 'wallbox', t('flow.wallbox'), wb, css('--s-wallbox'));
  if (showHeatpump) html += node('heatpump', 'heatpump', t('flow.heatpump'), hp, css('--s-heatpump'));
  svg.setAttribute('viewBox', `0 0 404 ${hasPv2 || showHeatpump ? 356 : 256}`);
  svg.innerHTML = html;
  if (!$('#bat-tip').hidden) showBatteryTip();
}

// Pop-up on the battery node: state of charge, discharging and charging power.
function showBatteryTip() {
  const tip = $('#bat-tip');
  const nodeEl = $('#flow .node.battery');
  if (!nodeEl) return;
  const bp = v('battery_power'); // positive = discharging
  const soc = v('battery_soc');
  const rows = [
    [t('flow.soc'), isNum(soc) ? `${nf(0).format(soc)} %` : '–'],
    [t('flow.discharge'), isNum(bp) ? fmtW(Math.max(0, bp)) : '–'],
    [t('flow.charge'), isNum(bp) ? fmtW(Math.max(0, -bp)) : '–'],
  ];
  tip.innerHTML = `<div class="tt-title">${esc(t('flow.battery'))}</div>`
    + rows.map(([k, val]) => `<div class="tt-row">${esc(k)}<b>${esc(val)}</b></div>`).join('');
  tip.hidden = false;
  // Right of the battery circle, vertically centered on it.
  const wrap = tip.parentElement.getBoundingClientRect();
  const r = nodeEl.querySelector('circle').getBoundingClientRect();
  tip.style.left = `${r.right - wrap.left + 8}px`;
  tip.style.top = `${r.top - wrap.top + r.height / 2 - tip.offsetHeight / 2}px`;
}

function renderToday() {
  const tot = today?.totals || {};
  const both = isNum(tot.pv_total_energy) && isNum(tot.pv2_energy);
  const tiles = [
    ['today.pv', tot.pv_total_energy],
    [pv2Name(), tot.pv2_energy],
    ['today.pvAll', both ? tot.pv_total_energy + tot.pv2_energy : undefined],
    ['today.gridIn', tot.meter_import_energy],
    ['today.gridOut', tot.meter_export_energy],
    ['today.out', tot.grid_total_export_energy],
    ['today.charge', tot.battery_total_charge_energy],
    ['today.discharge', tot.battery_total_discharge_energy],
    ['today.in', tot.grid_total_import_energy],
  ].filter(([, x]) => x !== undefined);
  $('#today').innerHTML = tiles.map(([k, x]) =>
    `<div class="tile"><div class="t">${esc(t(k))}</div><div class="v">${isNum(x) ? nf(2).format(x) : '–'}<small>kWh</small></div></div>`).join('')
    || '<p class="muted small">–</p>';
}

async function loadToday() {
  if (!S) return;
  try {
    today = await statistics('today');
    if (root && view === 'home') renderToday();
  } catch { /* shown via connection banner */ }
}

// --- history and statistics, read directly from the Home Assistant recorder ------

// Energy counters (total_increasing) used for daily / monthly statistics.
const ENERGY_KEYS = [
  'pv_total_energy',
  'battery_total_charge_energy',
  'battery_total_discharge_energy',
  'grid_total_export_energy',
  'grid_total_import_energy',
];
const HISTORY_KEYS = ['total_pv_power', 'battery_power', 'active_power', 'battery_soc'];
// Statistic keys of the extra devices -> entry in S.extra.entities.
const EXTRA_ENERGY_KEYS = {
  pv2_energy: 'pvEnergy',
  meter_import_energy: 'gridImportEnergy',
  meter_export_energy: 'gridExportEnergy',
};

const entityOf = (key) => S?.meta?.[key]?.entityId || null;
const extraEntity = (key) => S?.extra?.entities?.[key] || null;

function startOfDay(d = new Date()) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

// Average history samples into fixed buckets so charts stay light.
function bucketize(points, startMs, endMs, bucketMs) {
  const out = [];
  const now = Date.now();
  let i = 0;
  let last = null;
  for (let b = startMs; b < endMs; b += bucketMs) {
    if (b > now) break;
    let sum = 0;
    let weight = 0;
    // Time-weighted average of a step function within [b, b + bucketMs).
    let cursor = b;
    while (i < points.length && points[i][0] < b + bucketMs) {
      const [pt, pv] = points[i];
      if (pt > cursor && last !== null) {
        sum += last * (pt - cursor);
        weight += pt - cursor;
      }
      cursor = Math.max(cursor, pt);
      last = pv;
      i++;
    }
    const bucketEnd = Math.min(b + bucketMs, now);
    if (last !== null && bucketEnd > cursor) {
      sum += last * (bucketEnd - cursor);
      weight += bucketEnd - cursor;
    }
    out.push([b, weight ? Math.round((sum / weight) * 10) / 10 : null]);
  }
  return out;
}

// Power and SoC curves of one day in 5-minute buckets.
async function history(day) {
  const start = startOfDay(day);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);

  const ids = {};
  for (const k of HISTORY_KEYS) if (entityOf(k)) ids[k] = entityOf(k);
  if (extraEntity('gridPower')) ids.grid = extraEntity('gridPower');
  if (extraEntity('pvPower')) ids.pv2_power = extraEntity('pvPower');
  if (!Object.keys(ids).length) return { start: start.getTime(), end: end.getTime(), series: {} };

  const result = await hass.callWS({
    type: 'history/history_during_period',
    start_time: start.toISOString(),
    end_time: end.toISOString(),
    entity_ids: [...new Set(Object.values(ids))],
    minimal_response: true,
    no_attributes: true,
    include_start_time_state: true,
    significant_changes_only: false,
  });

  const series = {};
  for (const [key, id] of Object.entries(ids)) {
    let scale = hass.states[id]?.attributes?.unit_of_measurement === 'kW' ? 1000 : 1;
    if (key === 'grid' && S.settings.entities.gridPowerInverted) scale = -scale;
    const pts = (result[id] || [])
      .map((p) => [Math.max(start.getTime(), (p.lu ?? p.lc) * 1000), Number(p.s) * scale])
      .filter(([, x]) => Number.isFinite(x));
    series[key] = bucketize(pts, start.getTime(), end.getTime(), 5 * 60e3);
  }
  return { start: start.getTime(), end: end.getTime(), series };
}

// Energy per day (last 30 days) or month (last 12 months), or today's totals.
async function statistics(period) {
  const ids = {};
  for (const k of ENERGY_KEYS) if (entityOf(k)) ids[k] = entityOf(k);
  for (const [k, e] of Object.entries(EXTRA_ENERGY_KEYS)) if (extraEntity(e)) ids[k] = extraEntity(e);
  if (!Object.keys(ids).length) return period === 'today' ? { period, totals: {} } : { period, rows: [] };

  const now = new Date();
  let start = startOfDay(now);
  if (period === 'month') start = new Date(now.getFullYear() - 1, now.getMonth() + 1, 1);
  else if (period === 'day') start.setDate(start.getDate() - 29);

  const result = await hass.callWS({
    type: 'recorder/statistics_during_period',
    start_time: start.toISOString(),
    statistic_ids: [...new Set(Object.values(ids))],
    period: period === 'today' ? '5minute' : period,
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
      const st = typeof r.start === 'number' ? r.start : Date.parse(r.start);
      if (!rows.has(st)) rows.set(st, { start: st });
      rows.get(st)[key] = Math.round((r.change || 0) * 1000) / 1000;
    }
  }
  return { period, rows: [...rows.values()].sort((a, b) => a.start - b.start) };
}

// All power sensors in HA (W / kW), for choosing the smart meter.
function powerSensors() {
  return Object.values(hass.states)
    .filter((s) => s.entity_id.startsWith('sensor.') && ['W', 'kW'].includes(s.attributes.unit_of_measurement))
    .map((s) => ({
      entityId: s.entity_id,
      name: s.attributes.friendly_name || s.entity_id,
      state: s.state,
      unit: s.attributes.unit_of_measurement,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// --- control view -------------------------------------------------------------

function draft() {
  if (!ctlDraft) ctlDraft = structuredClone(S.settings.control);
  return ctlDraft;
}

function renderControl() {
  const c = ctlDraft || S.settings.control;
  for (const b of $$('#mode-seg button')) b.classList.toggle('on', b.dataset.v === c.mode);
  $('#mode-desc').textContent = t(`mode.${c.mode}.long`);
  $('#mode-status').innerHTML = `<span class="chip">${esc(t('ctl.now'))}: ${esc(controllerLabel())}</span>`;
  $('#constant-row').hidden = c.mode !== 'constant';
  const constEl = $('#constant');
  const maxEl = $('#max-output');
  if (active() !== constEl) constEl.value = c.constantW;
  if (active() !== maxEl) maxEl.value = c.maxOutputW;
  constEl.max = c.maxOutputW;
  $('#constant-val').textContent = fmtW(Number(c.constantW));
  $('#max-val').textContent = fmtW(Number(c.maxOutputW));
  if (!$('#schedule').contains(active())) renderSchedule(c);
  $('#save-control').disabled = !ctlDraft;

  const fm = v('force_mode');
  for (const [id, opt] of [['#force-charge', '3'], ['#force-discharge', '1']]) {
    const b = $(id);
    b.textContent = t(id === '#force-charge' ? 'force.charge' : 'force.discharge') + (String(fm) === opt ? ` · ${t('force.active')}` : '');
    b.classList.toggle('secondary', String(fm) !== opt);
  }
  renderBatterySettings();
}

function renderSchedule(c) {
  const days = t('days');
  const order = [1, 2, 3, 4, 5, 6, 0];
  $('#schedule').innerHTML = c.schedule.map((e, i) => `
    <div class="sched-item" data-i="${i}">
      <input type="checkbox" data-f="enabled" ${e.enabled !== false ? 'checked' : ''} aria-label="enabled">
      <input type="time" data-f="start" value="${esc(e.start)}">
      <input type="time" data-f="end" value="${esc(e.end)}">
      <div class="days">${order.map((d) => `<label><input type="checkbox" data-day="${d}" ${(!e.days?.length || e.days.includes(d)) ? 'checked' : ''}>${days[d]}</label>`).join('')}</div>
      <div class="bottom">
        <select data-f="mode">${['constant', 'zero', 'off'].map((m) => `<option value="${m}" ${e.mode === m ? 'selected' : ''}>${esc(t(`mode.${m}`))}</option>`).join('')}</select>
        <span ${e.mode !== 'constant' ? 'hidden' : ''}><input type="number" data-f="watts" value="${Number(e.watts) || 0}" min="0" max="800" step="10"> W</span>
        <button class="icon-btn" data-del aria-label="delete">✕</button>
      </div>
    </div>`).join('');
}

function onScheduleInput(ev) {
  const item = ev.target.closest('.sched-item');
  if (!item) return;
  const e = draft().schedule[Number(item.dataset.i)];
  const f = ev.target.dataset.f;
  if (ev.target.dataset.day !== undefined) {
    e.days = $$(`.sched-item[data-i="${item.dataset.i}"] [data-day]`).filter((x) => x.checked).map((x) => Number(x.dataset.day));
  } else if (f === 'enabled') e.enabled = ev.target.checked;
  else if (f === 'watts') e.watts = Number(ev.target.value);
  else if (f) e[f] = ev.target.value;
  if (f === 'mode') renderSchedule(draft());
  $('#save-control').disabled = false;
}

const SLIDERS = {
  battery: [
    ['minimum_soc', 'batset.min', '%'],
    ['minimum_soc_ongrid', 'batset.minOngrid', '%'],
    ['maximum_soc', 'batset.max', '%'],
    ['battery_max_charge_current', 'batset.maxCharge', 'A'],
    ['battery_max_discharge_current', 'batset.maxDischarge', 'A'],
  ],
  grid: [['grid_export_power_limit', 'gridset.exportLimit', 'W']],
};

function sliderHtml([key, label, unit]) {
  const m = S.meta[key];
  if (!m) return '';
  const val = v(key);
  return `<div class="slider" data-key="${key}">
    <header><span>${esc(t(label))}</span><b>${isNum(val) ? `${nf(0).format(val)} ${unit}` : '–'}</b></header>
    <input type="range" min="${m.min ?? 0}" max="${m.max ?? 100}" step="${m.step ?? 1}" value="${isNum(val) ? val : 0}">
  </div>`;
}

function renderBatterySettings() {
  for (const [box, list] of [['#battery-settings', SLIDERS.battery], ['#grid-settings', SLIDERS.grid]]) {
    const card = $(box);
    if (card.contains(active()) && active().type === 'range') continue;
    let html = `<h2>${esc(t(box === '#battery-settings' ? 'batset.title' : 'gridset.title'))}</h2>${list.map(sliderHtml).join('')}`;
    if (box === '#grid-settings' && S.meta.eps_output) {
      html += `<div class="row"><span class="lbl">${esc(t('gridset.eps'))}</span>
        <select data-select="eps_output">${['0', '2', '3'].map((o) => `<option value="${o}" ${String(v('eps_output')) === o ? 'selected' : ''}>${esc(t(`eps.${o}`))}</option>`).join('')}</select></div>`;
    }
    card.innerHTML = html;
  }
}

// --- device view ----------------------------------------------------------------

function kvTable(rows) {
  const body = rows.filter(([, x]) => x !== null && x !== undefined && x !== '–')
    .map(([k, x]) => `<tr><td>${esc(k)}</td><td>${esc(x)}</td></tr>`).join('');
  return body ? `<table class="kv"><tbody>${body}</tbody></table>` : '<p class="muted small">–</p>';
}

function renderDevice() {
  const d = S.device || {};
  const strings = [1, 2, 3, 4].filter((n) => S.meta[`pv${n}_power`]);
  const opmode = v('operating_mode');
  const remote = v('remote_control');
  const net = v('network_status');
  const gridStatus = S.values.grid_status;
  const cards = [];
  cards.push(`<div class="card"><h2>${esc(t('dev.info'))}</h2>${kvTable([
    [t('dev.model'), [d.model, d.modelId].filter(Boolean).join(' · ') || null],
    [t('dev.serial'), d.serial],
    [t('dev.fw'), d.swVersion],
    [`${t('dev.inverter')} ${t('dev.fw')}`, v('inverter_version')],
    [`${t('dev.bms')} ${t('dev.fw')}`, v('bms1_version')],
    [`${t('dev.pv')} ${t('dev.fw')}`, v('pv_version')],
  ])}</div>`);
  cards.push(`<div class="card"><h2>${esc(t('dev.status'))}</h2>${kvTable([
    [t('dev.opMode'), isNum(opmode) ? t('opmode')[opmode] ?? opmode : opmode],
    [t('dev.remote'), isNum(remote) ? t('remote')[remote] ?? remote : remote],
    [t('dev.countdown'), isNum(v('remote_timeout_countdown')) ? `${v('remote_timeout_countdown')} s` : null],
    [t('dev.network'), isNum(net) ? t('netstat')[net] ?? net : net],
    [t('dev.gridConn'), gridStatus === 'on' ? t('dev.connected') : gridStatus === 'off' ? t('dev.disconnected') : null],
  ])}</div>`);
  if (strings.length) {
    cards.push(`<div class="card"><h2>${esc(t('dev.pvStrings'))}</h2><div class="table-wrap"><table class="grid">
      <tr><th>${esc(t('dev.string'))}</th><th>V</th><th>A</th><th>W</th></tr>
      ${strings.map((n) => `<tr><td>${n}</td><td>${fmtU(v(`pv${n}_voltage`), '', 1)}</td><td>${fmtU(v(`pv${n}_current`), '', 2)}</td><td>${fmtU(v(`pv${n}_power`), '', 0)}</td></tr>`).join('')}
      <tr><td><b>Σ</b></td><td></td><td></td><td><b>${fmtU(v('total_pv_power'), '', 0)}</b></td></tr>
    </table></div></div>`);
  }
  cards.push(`<div class="card"><h2>${esc(t('dev.battery'))}</h2>${kvTable([
    ['SoC', fmtU(v('battery_soc'), '%', 0)],
    [t('dev.soh'), fmtU(v('bms1_soh'), '%', 0)],
    [t('bat.capacity'), fmtU(v('bms1_design_energy'), 'Wh', 0)],
    [t('bat.power'), fmtU(v('battery_power'), 'W', 0)],
    [t('dev.voltage'), fmtU(v('battery1_voltage'), 'V', 1)],
    [t('dev.current'), fmtU(v('battery1_current'), 'A', 2)],
    [t('dev.cellMin'), fmtU(v('bms1_min_cell_voltage'), 'V', 3)],
    [t('dev.cellMax'), fmtU(v('bms1_max_cell_voltage'), 'V', 3)],
    [t('dev.tempMin'), fmtU(v('bms1_min_temp'), '°C')],
    [t('dev.tempMax'), fmtU(v('bms1_max_temp'), '°C')],
  ])}</div>`);
  cards.push(`<div class="card"><h2>${esc(t('dev.grid'))}</h2>${kvTable([
    [t('dev.activePower'), fmtU(v('active_power'), 'W', 0)],
    [t('dev.reactivePower'), fmtU(v('reactive_power'), 'var', 0)],
    [t('dev.voltage'), fmtU(v('grid_r_voltage'), 'V', 1)],
    [t('dev.frequency'), fmtU(v('grid_frequency'), 'Hz', 2)],
    [t('dev.pf'), fmtU(v('power_factor'), '', 2)],
    [`${t('dev.eps')} ${t('dev.activePower')}`, fmtU(v('eps_power'), 'W', 0)],
    [`${t('dev.eps')} ${t('dev.voltage')}`, fmtU(v('eps_voltage'), 'V', 1)],
  ])}</div>`);
  cards.push(`<div class="card"><h2>${esc(t('dev.temps'))}</h2>${kvTable([
    [t('dev.invTemp'), fmtU(v('internal_temp'), '°C')],
    [t('dev.ambient'), fmtU(v('bms1_ambient_temp'), '°C')],
  ])}</div>`);
  cards.push(`<div class="card"><h2>${esc(t('dev.totals'))}</h2>${kvTable([
    [t('dev.totalPv'), fmtU(v('pv_total_energy'), 'kWh', 2)],
    [t('dev.totalOut'), fmtU(v('grid_total_export_energy'), 'kWh', 2)],
    [t('dev.totalIn'), fmtU(v('grid_total_import_energy'), 'kWh', 2)],
    [t('dev.totalCharge'), fmtU(v('battery_total_charge_energy'), 'kWh', 2)],
    [t('dev.totalDischarge'), fmtU(v('battery_total_discharge_energy'), 'kWh', 2)],
  ])}</div>`);
  const xd = S.extra?.devices || {};
  if (xd.pv) {
    cards.push(`<div class="card"><h2>${esc(xd.pv.name)}</h2>${kvTable([
      [t('dev.model'), [xd.pv.manufacturer, xd.pv.model].filter(Boolean).join(' ') || null],
      [t('dev.activePower'), fmtU(ex('pvPower'), 'W', 0)],
      [t('today.title'), isNum(today?.totals?.pv2_energy) ? kwh(today.totals.pv2_energy) : null],
      [t('dev.totalPv'), isNum(ex('pvEnergy')) ? kwh(ex('pvEnergy')) : null],
    ])}</div>`);
  }
  if (xd.wallbox) {
    cards.push(`<div class="card"><h2>${esc(xd.wallbox.name)}</h2>${kvTable([
      [t('dev.model'), [xd.wallbox.manufacturer, xd.wallbox.model].filter(Boolean).join(' ') || null],
      [t('set.wallbox.power'), fmtU(ex('wallboxPower'), 'W', 0)],
    ])}</div>`);
  }
  if (xd.heatpump) {
    cards.push(`<div class="card"><h2>${esc(xd.heatpump.name)}</h2>${kvTable([
      [t('dev.model'), [xd.heatpump.manufacturer, xd.heatpump.model].filter(Boolean).join(' ') || null],
      [t('set.heatpump.power'), fmtU(ex('heatpumpPower'), 'W', 0)],
    ])}</div>`);
  }
  if (xd.meter) {
    cards.push(`<div class="card"><h2>${esc(xd.meter.name)}</h2>${kvTable([
      [t('dev.model'), [xd.meter.manufacturer, xd.meter.model].filter(Boolean).join(' ') || null],
      [t('set.meter.entity'), fmtU(S.gridPower, 'W', 0)],
      [`${t('today.gridIn')} ${t('today.title')}`, isNum(today?.totals?.meter_import_energy) ? kwh(today.totals.meter_import_energy) : null],
      [`${t('today.gridOut')} ${t('today.title')}`, isNum(today?.totals?.meter_export_energy) ? kwh(today.totals.meter_export_energy) : null],
      [t('stats.meterIn'), isNum(ex('gridImportEnergy')) ? kwh(ex('gridImportEnergy')) : null],
      [t('stats.meterOut'), isNum(ex('gridExportEnergy')) ? kwh(ex('gridExportEnergy')) : null],
    ])}</div>`);
  }
  $('#device-cards').innerHTML = cards.join('');
}

// --- settings view --------------------------------------------------------------

let meterOptions = null;
function loadMeterOptions() {
  meterOptions = powerSensors();
  if (S) renderSettings(true);
}

let deviceSensors = null;
async function loadDeviceSensors() {
  try {
    deviceSensors = await ws('device_sensors');
  } catch {
    deviceSensors = null;
  }
  if (root) renderDeviceSettings();
}

// Sensor choices per extra entity: [settings key, device, unit filter]
const EXTRA_SELECTS = [
  ['pvPower', 'pv', ['W', 'kW']],
  ['pvEnergy', 'pv', ['Wh', 'kWh', 'MWh']],
  ['gridImportEnergy', 'meter', ['Wh', 'kWh', 'MWh']],
  ['gridExportEnergy', 'meter', ['Wh', 'kWh', 'MWh']],
  ['wallboxPower', 'wallbox', ['W', 'kW']],
  ['heatpumpPower', 'heatpump', ['W', 'kW']],
];

function renderDeviceSettings() {
  if (!S) return;
  const s = S.settings;
  $('#dev-pv').value = s.devices?.pv ?? '';
  $('#dev-meter').value = s.devices?.meter ?? '';
  $('#dev-wallbox').value = s.devices?.wallbox ?? '';
  $('#dev-heatpump').value = s.devices?.heatpump ?? '';
  for (const [key, dev, units] of EXTRA_SELECTS) {
    const sel = $(`#ent-${key}`);
    const opts = (deviceSensors?.sensors?.[dev] || []).filter((o) => units.includes(o.unit));
    const chosen = s.entities[key];
    if (chosen && !opts.some((o) => o.entityId === chosen)) opts.unshift({ entityId: chosen, name: chosen });
    const auto = deviceSensors?.entities?.[key];
    const autoName = !chosen && auto ? ` – ${opts.find((o) => o.entityId === auto)?.name || auto}` : '';
    sel.innerHTML = `<option value="">${esc(t('set.auto'))}${esc(autoName)}</option>`
      + opts.map((o) => `<option value="${esc(o.entityId)}">${esc(o.name)}${o.state ? ` (${esc(o.state)} ${esc(o.unit)})` : ''}</option>`).join('');
    sel.value = chosen || '';
  }
}

function renderSettings(force = false) {
  const s = S.settings;
  const sel = $('#meter');
  if (force || !sel.options.length) {
    const opts = (meterOptions || []).filter((o) => !Object.values(S.meta).some((m) => m.entityId === o.entityId));
    if (s.entities.gridPower && !opts.some((o) => o.entityId === s.entities.gridPower)) {
      opts.unshift({ entityId: s.entities.gridPower, name: s.entities.gridPower });
    }
    const meterName = S.extra?.devices?.meter?.name;
    sel.innerHTML = `<option value="">${esc(meterName ? `${t('set.auto')} – ${meterName}` : t('set.meter.none'))}</option>`
      + opts.map((o) => `<option value="${esc(o.entityId)}">${esc(o.name)}${o.state ? ` (${esc(o.state)} ${esc(o.unit)})` : ''}</option>`).join('');
    sel.value = s.entities.gridPower || '';
    $('#meter-invert').checked = !!s.entities.gridPowerInverted;
    const z = s.control.zero;
    $('#z-target').value = z.targetGridW;
    $('#z-deadband').value = z.deadbandW;
    $('#z-interval').value = z.intervalS;
    $('#z-smoothing').value = z.smoothing;
    $('#timeout').value = s.control.timeoutS;
  }
  $('#meter-now').textContent = isNum(S.gridPower) ? fmtW(S.gridPower) : '–';
  $('#conn-info').innerHTML = [
    [t('set.ha'), hass.config?.version],
    ['Status', hass.connected === false ? t('conn.bad') : t('conn.ok')],
    ['Device ID', S.device?.id],
  ].filter(([, x]) => x).map(([k, x]) => `<tr><td>${esc(k)}</td><td>${esc(x)}</td></tr>`).join('');
  $('#entity-list').innerHTML = Object.entries(S.meta).sort()
    .map(([k, m]) => `<tr><td>${esc(k)}</td><td style="text-align:left">${esc(m.entityId)}</td><td>${esc(S.values[k] ?? '–')}</td></tr>`).join('');
}

// --- statistics view ----------------------------------------------------------------

function dayDate() {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  return d;
}
const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

async function loadStats() {
  const d = dayDate();
  $('#day-label').textContent = dayOffset === 0 ? t('today.title') : d.toLocaleDateString(lang, { weekday: 'short', day: '2-digit', month: '2-digit' });
  $('#day-next').disabled = dayOffset >= 0;
  if (!S) return;
  try {
    const [h, e] = await Promise.all([history(d), statistics(energyPeriod)]);
    if (!root) return;
    drawHistory(h);
    drawEnergy(e);
    drawGrid(e);
  } catch (err) {
    toast(err.message, true);
  }
}

function drawHistory(h) {
  const xStart = h.start;
  const xEnd = h.end;
  const s = h.series;
  const series = [
    ['output', 'active_power', '--s-output'],
    ['pv', 'total_pv_power', '--s-pv'],
    ['pv2', 'pv2_power', '--s-pv2'],
    ['battery', 'battery_power', '--s-battery'],
    ['grid', 'grid', '--s-grid'],
  ].filter(([, k]) => s[k]).map(([name, k, color]) => ({ name: name === 'pv2' ? pv2Name() : t(`series.${name}`), color: css(color), points: s[k] }));
  lineChart($('#chart-power'), { series, xStart, xEnd, unit: 'W', fmt: fmtW, label: t('stats.power'), empty: '–' });
  lineChart($('#chart-soc'), {
    series: s.battery_soc ? [{ name: 'SoC', color: css('--s-battery'), points: s.battery_soc }] : [],
    xStart, xEnd, height: 120, yMin: 0, yMax: 100, fmt: (x) => `${nf(0).format(x)} %`, yTick: (x) => `${x}%`, label: t('stats.soc'), empty: '–',
  });
}

function drawEnergy(e) {
  const rows = e.rows || [];
  const label = (r) => {
    const d = new Date(r.start);
    return e.period === 'month' ? d.toLocaleDateString(lang, { month: 'short' }) : String(d.getDate());
  };
  const title = (r) => {
    const d = new Date(r.start);
    return e.period === 'month' ? d.toLocaleDateString(lang, { month: 'long', year: 'numeric' }) : d.toLocaleDateString(lang, { weekday: 'short', day: '2-digit', month: '2-digit' });
  };
  const val = (r, k) => (isNum(r[k]) ? r[k] : null);
  const cols = [
    ['pv', 'pv_total_energy', '--s-pv'],
    ['pv2', 'pv2_energy', '--s-pv2'],
    ['output', 'grid_total_export_energy', '--s-output'],
    ['charge', 'battery_total_charge_energy', '--s-battery'],
  ].filter(([, k]) => k !== 'pv2_energy' || rows.some((r) => k in r));
  const name = (n) => (n === 'pv2' ? pv2Name() : t(`series.${n}`));
  const box = $('#chart-energy');
  $('#energy-toggle').textContent = t(energyTable ? 'stats.chart' : 'stats.table');
  if (energyTable) {
    const all = [...cols, ['discharge', 'battery_total_discharge_energy'], ['import', 'grid_total_import_energy']];
    box.innerHTML = `<div class="table-wrap"><table class="grid"><tr><th></th>${all.map(([n]) => `<th>${esc(name(n))}</th>`).join('')}</tr>
      ${rows.slice().reverse().map((r) => `<tr><td>${esc(title(r))}</td>${all.map(([, k]) => `<td>${val(r, k) === null ? '–' : nf(2).format(r[k])}</td>`).join('')}</tr>`).join('')}
    </table></div><p class="muted small">kWh</p>`;
    return;
  }
  barChart(box, {
    labels: rows.map(label),
    titles: rows.map(title),
    series: cols.map(([n, k, c]) => ({ name: name(n), color: css(c), values: rows.map((r) => val(r, k)) })),
    fmt: kwh,
    extraRows: (i) => [
      { name: t('series.discharge'), color: 'transparent', value: isNum(rows[i].battery_total_discharge_energy) ? kwh(rows[i].battery_total_discharge_energy) : '–' },
    ],
    label: t('stats.energy'),
    empty: '–',
  });
}

// Grid meter: import and feed-in per day / month, with sums over the period and meter readings.
function drawGrid(e) {
  const rows = e.rows || [];
  const keys = [['gridIn', 'meter_import_energy', '--s-grid'], ['gridOut', 'meter_export_energy', '--s-export']]
    .filter(([, k]) => rows.some((r) => k in r));
  $('#grid-card').hidden = !keys.length;
  if (!keys.length) return;
  const sum = (k) => rows.reduce((a, r) => a + (isNum(r[k]) ? r[k] : 0), 0);
  const span = t(e.period === 'month' ? 'stats.months' : 'stats.days');
  const tiles = [
    ...keys.map(([n, k]) => [`${t(`today.${n}`)} · ${span}`, sum(k)]),
    [t('stats.meterIn'), ex('gridImportEnergy')],
    [t('stats.meterOut'), ex('gridExportEnergy')],
  ].filter(([, x]) => isNum(x));
  $('#grid-sums').innerHTML = tiles.map(([k, x]) =>
    `<div class="tile"><div class="t">${esc(k)}</div><div class="v">${nf(2).format(x)}<small>kWh</small></div></div>`).join('');

  const title = (r) => {
    const d = new Date(r.start);
    return e.period === 'month' ? d.toLocaleDateString(lang, { month: 'long', year: 'numeric' }) : d.toLocaleDateString(lang, { weekday: 'short', day: '2-digit', month: '2-digit' });
  };
  const box = $('#chart-grid');
  $('#grid-toggle').textContent = t(gridTable ? 'stats.chart' : 'stats.table');
  if (gridTable) {
    const cell = (x) => `<td>${isNum(x) ? nf(2).format(x) : '–'}</td>`;
    box.innerHTML = `<div class="table-wrap"><table class="grid"><tr><th></th>${keys.map(([n]) => `<th>${esc(t(`today.${n}`))}</th>`).join('')}<th>${esc(t('stats.net'))}</th></tr>
      ${rows.slice().reverse().map((r) => `<tr><td>${esc(title(r))}</td>${keys.map(([, k]) => cell(r[k])).join('')}${cell(isNum(r.meter_import_energy) && isNum(r.meter_export_energy) ? r.meter_import_energy - r.meter_export_energy : null)}</tr>`).join('')}
      <tr><td><b>Σ</b></td>${keys.map(([, k]) => `<td><b>${nf(2).format(sum(k))}</b></td>`).join('')}<td><b>${keys.length === 2 ? nf(2).format(sum('meter_import_energy') - sum('meter_export_energy')) : '–'}</b></td></tr>
    </table></div><p class="muted small">kWh · ${esc(t('stats.netHint'))}</p>`;
    return;
  }
  barChart(box, {
    labels: rows.map((r) => {
      const d = new Date(r.start);
      return e.period === 'month' ? d.toLocaleDateString(lang, { month: 'short' }) : String(d.getDate());
    }),
    titles: rows.map(title),
    series: keys.map(([n, k, c]) => ({ name: t(`today.${n}`), color: css(c), values: rows.map((r) => (isNum(r[k]) ? r[k] : null)) })),
    fmt: kwh,
    label: t('stats.grid'),
    empty: '–',
  });
}

// --- events -----------------------------------------------------------------

// Listeners on the panel's own elements are added once per shadow root, which lives as long as the panel.
const boundRoots = new WeakSet();

function bind(signal) {
  observeResize(signal);
  if (boundRoots.has(root)) return;
  boundRoots.add(root);
  for (const b of $$('nav.tabs button')) b.addEventListener('click', () => show(b.dataset.view));

  // Battery pop-up: hover with a mouse, tap on touch screens.
  const flow = $('#flow');
  const onBattery = (e) => !!e.target.closest?.('.node.battery');
  flow.addEventListener('pointerover', (e) => { if (e.pointerType === 'mouse' && onBattery(e)) showBatteryTip(); });
  flow.addEventListener('pointerout', (e) => {
    if (e.pointerType === 'mouse' && onBattery(e) && !e.relatedTarget?.closest?.('.node.battery')) $('#bat-tip').hidden = true;
  });
  flow.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return;
    if (onBattery(e) && $('#bat-tip').hidden) showBatteryTip();
    else $('#bat-tip').hidden = true;
  });

  // Control: mode + sliders + schedule
  for (const b of $$('#mode-seg button')) {
    b.addEventListener('click', () => {
      draft().mode = b.dataset.v;
      renderControl();
    });
  }
  $('#constant').addEventListener('input', (e) => { draft().constantW = Number(e.target.value); renderControl(); });
  $('#max-output').addEventListener('input', (e) => {
    const d = draft();
    d.maxOutputW = Number(e.target.value);
    d.constantW = Math.min(d.constantW, d.maxOutputW);
    renderControl();
  });
  $('#schedule').addEventListener('change', onScheduleInput);
  $('#schedule').addEventListener('click', (e) => {
    if (!e.target.matches('[data-del]')) return;
    const i = Number(e.target.closest('.sched-item').dataset.i);
    draft().schedule.splice(i, 1);
    renderSchedule(draft());
    $('#save-control').disabled = false;
  });
  $('#add-window').addEventListener('click', () => {
    draft().schedule.push({ enabled: true, days: [], start: '22:00', end: '06:00', mode: 'constant', watts: 100 });
    renderSchedule(draft());
    $('#save-control').disabled = false;
  });
  $('#save-control').addEventListener('click', () => act(async () => {
    await ws('update_settings', { settings: { control: draft() } });
    ctlDraft = null;
  }, t('ctl.saved')));

  // Force charge / discharge
  const force = (action) => act(async () => {
    const w = Number($('#force-w').value);
    const m = Number($('#force-min').value);
    if (action !== 'stop' && !confirm(t(`confirm.${action}`).replace('{w}', w).replace('{m}', m))) return;
    await ws('force', action === 'stop' ? { action } : { action, watts: w, minutes: m });
  }, '✓');
  $('#force-charge').addEventListener('click', () => force('charge'));
  $('#force-discharge').addEventListener('click', () => force('discharge'));
  $('#force-stop').addEventListener('click', () => force('stop'));

  // Device settings (delegated: cards are re-rendered)
  for (const box of ['#battery-settings', '#grid-settings']) {
    $(box).addEventListener('input', (e) => {
      const s = e.target.closest('.slider');
      if (!s) return;
      const unit = SLIDERS.battery.concat(SLIDERS.grid).find(([k]) => k === s.dataset.key)[2];
      s.querySelector('b').textContent = `${nf(0).format(Number(e.target.value))} ${unit}`;
    });
    $(box).addEventListener('change', (e) => {
      const s = e.target.closest('.slider');
      if (s) {
        act(() => ws('set_number', { key: s.dataset.key, value: Number(e.target.value) }), '✓');
        e.target.blur();
      }
      if (e.target.dataset.select) {
        act(() => ws('select_option', { key: e.target.dataset.select, option: e.target.value }), '✓');
      }
    });
  }

  // Statistics
  $('#day-prev').addEventListener('click', () => { dayOffset--; loadStats(); });
  $('#day-next').addEventListener('click', () => { if (dayOffset < 0) { dayOffset++; loadStats(); } });
  for (const b of $$('#energy-period button')) {
    b.addEventListener('click', () => {
      energyPeriod = b.dataset.v;
      $$('#energy-period button').forEach((x) => x.classList.toggle('on', x === b));
      loadStats();
    });
  }
  $('#energy-toggle').addEventListener('click', () => { energyTable = !energyTable; loadStats(); });

  // Settings
  $('#lang').addEventListener('change', (e) => {
    langPref = e.target.value;
    storage('solakon.lang', langPref);
    applyI18n();
    render();
    if (view === 'settings' && S) renderSettings(true);
    if (view === 'stats') loadStats();
  });
  $('#save-settings').addEventListener('click', () => act(async () => {
    await ws('update_settings', {
      settings: {
        entities: { gridPower: $('#meter').value, gridPowerInverted: $('#meter-invert').checked },
        control: {
          timeoutS: Number($('#timeout').value),
          zero: {
            targetGridW: Number($('#z-target').value),
            deadbandW: Number($('#z-deadband').value),
            intervalS: Number($('#z-interval').value),
            smoothing: Number($('#z-smoothing').value),
          },
        },
      },
    });
  }, t('ctl.saved')));
  $('#save-devices').addEventListener('click', () => act(async () => {
    const entities = {};
    for (const [key] of EXTRA_SELECTS) entities[key] = $(`#ent-${key}`).value;
    await ws('update_settings', {
      settings: {
        devices: {
          pv: $('#dev-pv').value.trim(),
          meter: $('#dev-meter').value.trim(),
          wallbox: $('#dev-wallbox').value.trim(),
          heatpump: $('#dev-heatpump').value.trim(),
        },
        entities,
      },
    });
    await loadDeviceSensors();
    loadToday();
  }, t('ctl.saved')));
  $('#grid-toggle').addEventListener('click', () => { gridTable = !gridTable; loadStats(); });
  $('#rediscover').addEventListener('click', () => act(() => ws('rediscover'), '✓'));

}

// Redraw the charts when the panel is resized (sidebar toggled, window resized).
function observeResize(signal) {
  let resizeTimer;
  const ro = new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (view === 'stats') loadStats(); }, 250);
  });
  ro.observe($('#content'));
  signal.addEventListener('abort', () => { ro.disconnect(); clearTimeout(resizeTimer); });
}

// --- lifecycle (called by solakon-panel.js) ------------------------------------------

// Incremented on every mount, so callbacks of an earlier mount can tell they are stale.
let generation = 0;

async function subscribe() {
  const gen = generation;
  try {
    const unsub = await hass.connection.subscribeMessage((state) => {
      if (gen !== generation) return;
      const first = !S;
      S = state;
      subError = null;
      render();
      if (first) {
        loadToday();
        // Views opened before the first state need the device names and settings.
        if (view === 'stats') loadStats();
        if (view === 'settings') { loadMeterOptions(); renderDeviceSettings(); }
      }
    }, { type: 'solakon_local/subscribe' });
    // Unmounted while the subscription was being set up.
    if (gen !== generation || !root) unsub();
    else unsubscribe = unsub;
  } catch (err) {
    if (gen !== generation || !root) return;
    subError = err?.message || String(err);
    renderHeader();
  }
}

export function mount(shadowRoot, h) {
  generation++;
  root = shadowRoot;
  hass = h;
  listeners = new AbortController();
  applyTheme();
  applyI18n();
  bind(listeners.signal);
  show(view);
  subscribe();
  todayTimer = setInterval(loadToday, 60000);
}

export function setHass(h) {
  const prev = hass;
  hass = h;
  if (applyTheme()) {
    render();
    if (view === 'stats') loadStats();
  }
  if (!langPref && (prev?.locale?.language !== h.locale?.language)) {
    applyI18n();
    render();
  }
  if (prev?.connected !== h.connected) renderHeader();
}

export function unmount() {
  generation++;
  listeners?.abort();
  clearInterval(todayTimer);
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
  root = null;
  hass = null;
  S = null;
  subError = null;
  dark = null;
  ctlDraft = null;
}
