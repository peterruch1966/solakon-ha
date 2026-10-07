import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockHa } from './mock-ha.js';

const HA_PORT = 18123;
const APP_PORT = 18099;
const base = `http://127.0.0.1:${APP_PORT}`;
let ha;
let app;
let dataDir;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeout = 8000) {
  const end = Date.now() + timeout;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch { /* retry */ }
    if (Date.now() > end) throw new Error('timeout');
    await sleep(100);
  }
}
const get = (p) => fetch(base + p).then((r) => r.json());
const send = (method, p, body) => fetch(base + p, {
  method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, body: await r.json() }));

before(async () => {
  ha = await startMockHa(HA_PORT);
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solakon-'));
  app = spawn(process.execPath, ['src/server.js'], {
    env: { ...process.env, PORT: APP_PORT, HA_URL: `http://127.0.0.1:${HA_PORT}`, HA_TOKEN: 'test', DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  app.stderr.on('data', (d) => process.stderr.write(d));
  await waitFor(async () => (await get('/api/state')).values?.battery_soc === 64);
});

after(() => {
  app?.kill();
  ha?.close();
});

test('discovers entities by unique id and exposes device info', async () => {
  const s = await get('/api/state');
  assert.equal(s.ha.connected, true);
  assert.equal(s.device.serial, 'SN123456');
  assert.equal(s.meta.remote_control_mode.entityId, 'select.solakon_one_modus_fernsteuern');
  assert.equal(s.values.total_pv_power, 610);
  assert.equal(s.values.grid_status, 'on');
});

test('serves the UI', async () => {
  const html = await fetch(base + '/').then((r) => r.text());
  assert.match(html, /Solakon Local/);
  const r = await fetch(base + '/../src/config.js');
  assert.notEqual(r.status, 200);
});

test('live updates reach the state', async () => {
  ha.setState('sensor.solakon_one_akku_ladezustand', 71);
  await waitFor(async () => (await get('/api/state')).values.battery_soc === 71);
});

test('writes device settings with validation', async () => {
  let r = await send('POST', '/api/number', { key: 'minimum_soc', value: 20 });
  assert.equal(r.status, 200);
  assert.deepEqual(ha.serviceCalls.at(-1), { domain: 'number', service: 'set_value', entity_id: 'number.solakon_one_minimaler_ladezustand', data: { value: 20 } });
  r = await send('POST', '/api/number', { key: 'grid_export_power_limit', value: 1000 });
  assert.equal(r.status, 400);
  r = await send('POST', '/api/number', { key: 'remote_active_power', value: 100 });
  assert.equal(r.status, 400, 'remote registers are owned by the controller');
  r = await send('POST', '/api/select', { key: 'eps_output', option: '2' });
  assert.equal(r.status, 200);
});

test('history and statistics', async () => {
  const h = await get('/api/history');
  assert.ok(h.series.total_pv_power.length > 0);
  const st = await get('/api/statistics?period=day');
  assert.equal(st.rows.length, 30);
  const td = await get('/api/statistics?period=today');
  assert.ok('pv_total_energy' in td.totals);
});

test('finds the PV inverter and grid meter by device name', async () => {
  const s = await get('/api/state');
  assert.equal(s.extra.devices.pv.name, 'Solaranlage Hoymiles');
  assert.equal(s.extra.devices.meter.name, 'PowerMeter');
  assert.deepEqual(s.extra.entities, {
    pvPower: 'sensor.solaranlage_hoymiles_power',
    pvEnergy: 'sensor.solaranlage_hoymiles_yieldtotal',
    gridPower: 'sensor.powermeter_power',
    gridImportEnergy: 'sensor.powermeter_total_energy',
    gridExportEnergy: 'sensor.powermeter_total_energy_returned',
  });
  assert.equal(s.extra.pvPower, 420);
  assert.equal(s.extra.gridImportEnergy, 4321);
  assert.equal(s.extra.gridExportEnergy, 987.6);
  assert.equal(s.gridPower, -120);

  const h = await get('/api/history');
  assert.ok(h.series.pv2_power.length > 0);
  assert.ok(h.series.grid.length > 0);
  const st = await get('/api/statistics?period=day');
  assert.ok('meter_import_energy' in st.rows[0] && 'meter_export_energy' in st.rows[0] && 'pv2_energy' in st.rows[0]);
  const td = await get('/api/statistics?period=today');
  assert.ok('meter_export_energy' in td.totals);
});

test('manual sensor choice overrides auto-detection; no meter blocks zero feed-in', async () => {
  let r = await send('PUT', '/api/settings', { entities: { pvEnergy: 'sensor.solaranlage_hoymiles_yieldday' } });
  assert.equal(r.status, 200);
  let s = await get('/api/state');
  assert.equal(s.extra.entities.pvEnergy, 'sensor.solaranlage_hoymiles_yieldday');
  assert.equal(s.extra.pvEnergy, 1.83, 'Wh are converted to kWh');

  r = await send('PUT', '/api/settings', { devices: { meter: '' }, entities: { pvEnergy: '' } });
  assert.equal(r.status, 200);
  s = await get('/api/state');
  assert.equal(s.extra.devices.meter, null);
  assert.equal(s.gridPower, null);
  r = await send('PUT', '/api/settings', { control: { mode: 'zero' } });
  assert.equal(r.status, 400);
});

test('zero feed-in regulates with the smart meter', async () => {
  let r;
  ha.serviceCalls.length = 0;
  ha.setState('sensor.shelly_3em_power', 150); // importing 150 W
  ha.setState('sensor.solakon_one_wirkleistung', 280);
  r = await send('PUT', '/api/settings', {
    entities: { gridPower: 'sensor.shelly_3em_power' },
    control: { mode: 'zero', zero: { smoothing: 1, targetGridW: 10 } },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const s = await waitFor(async () => {
    const st = await get('/api/state');
    return st.values.remote_control_mode === 1 && st;
  });
  assert.equal(s.gridPower, 150);
  assert.equal(s.controller.mode, 'zero');
  assert.equal(s.controller.targetW, 420); // 280 + (150 - 10)
  const calls = ha.serviceCalls.map((c) => `${c.entity_id}=${c.data.value ?? c.data.option}`);
  const power = calls.indexOf('number.solakon_one_fernsteuerung_leistung=420');
  const mode = calls.indexOf('select.solakon_one_modus_fernsteuern=1');
  assert.ok(power !== -1 && mode !== -1 && power < mode, `setpoint before mode: ${calls}`);
  assert.ok(calls.includes('number.solakon_one_fernsteuerung_timeout=120'));
});

test('switching to off releases remote control', async () => {
  const r = await send('PUT', '/api/settings', { control: { mode: 'off' } });
  assert.equal(r.status, 200);
  await waitFor(async () => (await get('/api/state')).values.remote_control_mode === 0);
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8'));
  assert.equal(saved.control.mode, 'off');
  assert.equal(saved.entities.gridPower, 'sensor.shelly_3em_power');
});

test('force discharge is capped at 800 W and pauses the controller', async () => {
  let r = await send('POST', '/api/force', { action: 'discharge', watts: 900, minutes: 10 });
  assert.equal(r.status, 400);
  r = await send('POST', '/api/force', { action: 'discharge', watts: 500, minutes: 10 });
  assert.equal(r.status, 200);
  const s = await waitFor(async () => {
    const st = await get('/api/state');
    return st.values.force_mode === 1 && st;
  });
  assert.equal(s.values.force_power, 500);
  r = await send('POST', '/api/force', { action: 'stop' });
  assert.equal(r.status, 200);
});
