// A tiny fake Home Assistant WebSocket API for local development and tests.
// Usage: node test/mock-ha.js [port]   (token: "test")
import http from 'node:http';
import crypto from 'node:crypto';

const ENTRY = '01JTESTENTRYID00000000000';
const DEVICE = 'dev-solakon-1';

const ENTITIES = {
  // key: [entity_id, state, attributes]
  battery_soc: ['sensor.solakon_one_akku_ladezustand', 64, { unit_of_measurement: '%' }],
  battery_power: ['sensor.solakon_one_akkuleistung', -320, { unit_of_measurement: 'W' }],
  total_pv_power: ['sensor.solakon_one_pv_leistung', 610, { unit_of_measurement: 'W' }],
  active_power: ['sensor.solakon_one_wirkleistung', 280, { unit_of_measurement: 'W' }],
  pv1_power: ['sensor.solakon_one_string_1_leistung', 330, { unit_of_measurement: 'W' }],
  pv2_power: ['sensor.solakon_one_string_2_leistung', 280, { unit_of_measurement: 'W' }],
  pv1_voltage: ['sensor.solakon_one_string_1_spannung', 38.2, { unit_of_measurement: 'V' }],
  pv2_voltage: ['sensor.solakon_one_string_2_spannung', 36.9, { unit_of_measurement: 'V' }],
  pv1_current: ['sensor.solakon_one_string_1_strom', 8.64, { unit_of_measurement: 'A' }],
  pv2_current: ['sensor.solakon_one_string_2_strom', 7.59, { unit_of_measurement: 'A' }],
  bms1_design_energy: ['sensor.solakon_one_akkukapazitat', 2048, { unit_of_measurement: 'Wh' }],
  bms1_max_temp: ['sensor.solakon_one_akku_max_temperatur', 24.5, { unit_of_measurement: '°C' }],
  bms1_min_temp: ['sensor.solakon_one_akku_min_temperatur', 22.0, { unit_of_measurement: '°C' }],
  bms1_soh: ['sensor.solakon_one_akku_gesundheit', 100, { unit_of_measurement: '%' }],
  internal_temp: ['sensor.solakon_one_wechselrichtertemperatur', 38.1, { unit_of_measurement: '°C' }],
  grid_r_voltage: ['sensor.solakon_one_netzspannung', 231.4, { unit_of_measurement: 'V' }],
  grid_frequency: ['sensor.solakon_one_netzfrequenz', 50.01, { unit_of_measurement: 'Hz' }],
  operating_mode: ['sensor.solakon_one_betriebsmodus', 1, {}],
  remote_control: ['sensor.solakon_one_fernsteuerung', 0, {}],
  remote_timeout_countdown: ['sensor.solakon_one_fernsteuerung_restzeit', 0, { unit_of_measurement: 's' }],
  network_status: ['sensor.solakon_one_netzwerk', 2, {}],
  inverter_version: ['sensor.solakon_one_wechselrichter_version', '1.2.3', {}],
  pv_total_energy: ['sensor.solakon_one_pv_energie', 123.4, { unit_of_measurement: 'kWh' }],
  grid_total_export_energy: ['sensor.solakon_one_netzeinspeisung', 98.7, { unit_of_measurement: 'kWh' }],
  grid_total_import_energy: ['sensor.solakon_one_netzbezug', 1.2, { unit_of_measurement: 'kWh' }],
  battery_total_charge_energy: ['sensor.solakon_one_akku_ladeenergie', 55.5, { unit_of_measurement: 'kWh' }],
  battery_total_discharge_energy: ['sensor.solakon_one_akku_entladeenergie', 50.1, { unit_of_measurement: 'kWh' }],
  grid_status: ['binary_sensor.solakon_one_netz', 'on', {}],
  minimum_soc: ['number.solakon_one_minimaler_ladezustand', 10, { min: 10, max: 100, step: 1, unit_of_measurement: '%' }],
  maximum_soc: ['number.solakon_one_maximaler_ladezustand', 100, { min: 0, max: 100, step: 1, unit_of_measurement: '%' }],
  minimum_soc_ongrid: ['number.solakon_one_minimaler_ladezustand_netz', 10, { min: 10, max: 100, step: 1, unit_of_measurement: '%' }],
  grid_export_power_limit: ['number.solakon_one_einspeisebegrenzung', 800, { min: 0, max: 800, step: 10, unit_of_measurement: 'W' }],
  remote_active_power: ['number.solakon_one_fernsteuerung_leistung', 0, { min: -100000, max: 800, step: 100, unit_of_measurement: 'W' }],
  remote_timeout_set: ['number.solakon_one_fernsteuerung_timeout', 0, { min: 0, max: 3600, step: 10, unit_of_measurement: 's' }],
  force_power: ['number.solakon_one_force_leistung', 0, { min: 0, max: 1200, step: 10, unit_of_measurement: 'W' }],
  force_duration: ['number.solakon_one_force_dauer', 0, { min: 0, max: 1092, step: 1, unit_of_measurement: 'min' }],
  remote_control_mode: ['select.solakon_one_modus_fernsteuern', '0', { options: ['0', '1', '3', '5', '7', '9', '11', '13', '15'] }],
  force_mode: ['select.solakon_one_force_modus', '0', { options: ['0', '1', '3'] }],
  eps_output: ['select.solakon_one_ausgang', '0', { options: ['0', '2', '3'] }],
};

const states = {};
for (const [, [id, s, a]] of Object.entries(ENTITIES)) states[id] = { s: String(s), a };
states['sensor.shelly_3em_power'] = { s: '150', a: { unit_of_measurement: 'W', friendly_name: 'Shelly 3EM Power' } };

// Other devices found by name: a Hoymiles micro inverter (OpenDTU style), a grid meter (Shelly style) and a KEBA wallbox.
const energyAttrs = (unit, name) => ({ unit_of_measurement: unit, device_class: 'energy', state_class: 'total_increasing', friendly_name: name });
const powerAttrs = (name) => ({ unit_of_measurement: 'W', device_class: 'power', state_class: 'measurement', friendly_name: name });
const OTHER_DEVICES = {
  'dev-hoymiles': ['Solaranlage Hoymiles', {
    'sensor.solaranlage_hoymiles_power': ['420', powerAttrs('Solaranlage Hoymiles Power')],
    'sensor.solaranlage_hoymiles_power_dc': ['441', powerAttrs('Solaranlage Hoymiles Power DC')],
    'sensor.solaranlage_hoymiles_yieldday': ['1830', energyAttrs('Wh', 'Solaranlage Hoymiles YieldDay')],
    'sensor.solaranlage_hoymiles_yieldtotal': ['812.5', energyAttrs('kWh', 'Solaranlage Hoymiles YieldTotal')],
  }],
  'dev-meter': ['PowerMeter', {
    'sensor.powermeter_phase_a_power': ['-40', powerAttrs('PowerMeter Phase A power')],
    'sensor.powermeter_power': ['-120', powerAttrs('PowerMeter Power')],
    'sensor.powermeter_phase_a_energy': ['1500', energyAttrs('kWh', 'PowerMeter Phase A energy')],
    'sensor.powermeter_total_energy': ['4321', energyAttrs('kWh', 'PowerMeter Total energy')],
    'sensor.powermeter_total_energy_returned': ['987.6', energyAttrs('kWh', 'PowerMeter Total energy returned')],
  }],
  // KEBA integration: power in kW, plus current and energy sensors that must not be picked.
  'dev-keba': ['KEBA P30', {
    'sensor.keba_p30_max_current': ['16', { unit_of_measurement: 'A', friendly_name: 'KEBA P30 Max current' }],
    'sensor.keba_p30_charging_power': ['3.7', { ...powerAttrs('KEBA P30 Charging power'), unit_of_measurement: 'kW' }],
    'sensor.keba_p30_total_energy': ['1234.5', energyAttrs('kWh', 'KEBA P30 Total energy')],
  }],
};
for (const [, [, ents]] of Object.entries(OTHER_DEVICES)) {
  for (const [id, [s, a]] of Object.entries(ents)) states[id] = { s, a };
}

export const serviceCalls = [];

function frame(str) {
  const payload = Buffer.from(str);
  const len = payload.length;
  let header;
  if (len < 126) header = Buffer.from([0x81, len]);
  else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81; header[1] = 126; header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function* parseFrames(state) {
  while (state.buf.length >= 2) {
    const b = state.buf;
    const opcode = b[0] & 0x0f;
    let len = b[1] & 0x7f;
    let off = 2;
    if (len === 126) { len = b.readUInt16BE(2); off = 4; } else if (len === 127) { len = Number(b.readBigUInt64BE(2)); off = 10; }
    const masked = b[1] & 0x80;
    const total = off + (masked ? 4 : 0) + len;
    if (b.length < total) return;
    let data = b.subarray(off + (masked ? 4 : 0), total);
    if (masked) {
      const mask = b.subarray(off, off + 4);
      data = Buffer.from(data.map((x, i) => x ^ mask[i % 4]));
    }
    state.buf = b.subarray(total);
    yield { opcode, data: data.toString() };
  }
}

export function startMockHa(port = 8123) {
  const sockets = new Set();
  const server = http.createServer((req, res) => { res.writeHead(401); res.end(); });
  server.on('upgrade', (req, socket) => {
    const accept = crypto.createHash('sha1')
      .update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const conn = { socket, subs: new Map(), buf: Buffer.alloc(0) };
    sockets.add(conn);
    const send = (m) => socket.write(frame(JSON.stringify(m)));
    send({ type: 'auth_required', ha_version: 'mock' });
    socket.on('data', (d) => {
      conn.buf = Buffer.concat([conn.buf, d]);
      for (const f of parseFrames(conn)) {
        if (f.opcode === 8) { socket.end(); return; }
        if (f.opcode !== 1) continue;
        handle(conn, JSON.parse(f.data), send);
      }
    });
    socket.on('close', () => sockets.delete(conn));
    socket.on('error', () => sockets.delete(conn));
  });

  function pushChange(id) {
    for (const c of sockets) {
      for (const [subId, ids] of c.subs) {
        if (ids.includes(id)) {
          c.socket.write(frame(JSON.stringify({ id: subId, type: 'event', event: { c: { [id]: { '+': { s: states[id].s, lu: Date.now() / 1000 } } } } })));
        }
      }
    }
  }

  function handle(conn, msg, send) {
    const ok = (result = null) => send({ id: msg.id, type: 'result', success: true, result });
    switch (msg.type) {
      case 'auth':
        send(msg.access_token === 'test' ? { type: 'auth_ok', ha_version: 'mock' } : { type: 'auth_invalid', message: 'Invalid access token' });
        break;
      case 'config/entity_registry/list':
        ok(Object.entries(ENTITIES).map(([key, [id]]) => ({
          entity_id: id, platform: 'solakon_one', unique_id: `${ENTRY}_${key}`, device_id: DEVICE, disabled_by: null,
        })).concat([{ entity_id: 'sensor.shelly_3em_power', platform: 'shelly', unique_id: 'x', device_id: 'shelly', disabled_by: null }])
          .concat(Object.entries(OTHER_DEVICES).flatMap(([dev, [, ents]]) => Object.keys(ents).map((id) => ({
            entity_id: id, platform: 'mqtt', unique_id: id, device_id: dev, disabled_by: null,
          })))));
        break;
      case 'config/device_registry/list':
        ok([{ id: DEVICE, name: 'Solakon ONE', manufacturer: 'Solakon', model: 'Solakon ONE', model_id: 'SOL-ONE', serial_number: 'SN123456', sw_version: '1.0.0' }]
          .concat(Object.entries(OTHER_DEVICES).map(([id, [name]]) => ({ id, name, name_by_user: null, manufacturer: 'Mock', model: name }))));
        break;
      case 'subscribe_entities': {
        conn.subs.set(msg.id, msg.entity_ids);
        ok();
        const a = {};
        for (const id of msg.entity_ids) if (states[id]) a[id] = { s: states[id].s, a: states[id].a, lu: Date.now() / 1000 };
        send({ id: msg.id, type: 'event', event: { a } });
        break;
      }
      case 'unsubscribe_events':
        conn.subs.delete(msg.subscription);
        ok();
        break;
      case 'get_states':
        ok(Object.entries(states).map(([entity_id, s]) => ({ entity_id, state: s.s, attributes: s.a })));
        break;
      case 'call_service': {
        const id = msg.target.entity_id;
        serviceCalls.push({ domain: msg.domain, service: msg.service, entity_id: id, data: msg.service_data });
        if (!states[id]) {
          send({ id: msg.id, type: 'result', success: false, error: { message: 'Entity not found' } });
          return;
        }
        const val = msg.service_data.value ?? msg.service_data.option;
        states[id].s = String(val);
        // Mirror the select into the read-only remote_control sensor, like the device would.
        if (id === ENTITIES.remote_control_mode[0]) {
          states[ENTITIES.remote_control[0]].s = String(val);
          pushChange(ENTITIES.remote_control[0]);
        }
        pushChange(id);
        ok({ context: {} });
        break;
      }
      case 'history/history_during_period': {
        const start = Date.parse(msg.start_time) / 1000;
        const end = Math.min(Date.parse(msg.end_time) / 1000, Date.now() / 1000);
        const res = {};
        for (const id of msg.entity_ids) {
          const pts = [];
          for (let t = start; t < end; t += 600) {
            const h = ((t - start) / 3600);
            const sun = Math.max(0, Math.sin(((h - 6) / 14) * Math.PI));
            let v = 0;
            if (id.includes('pv_leistung')) v = 800 * sun;
            else if (id.includes('akkuleistung')) v = h > 18 || h < 6 ? 200 : -400 * sun;
            else if (id.includes('wirkleistung')) v = 200 + 200 * sun;
            else if (id.includes('ladezustand')) v = Math.min(100, 20 + h * 4);
            else if (id.includes('shelly') || id.includes('powermeter')) v = 100 - 150 * sun;
            else if (id.includes('hoymiles')) v = 600 * sun;
            pts.push({ s: String(Math.round(v)), lu: t });
          }
          res[id] = pts;
        }
        ok(res);
        break;
      }
      case 'recorder/statistics_during_period': {
        const res = {};
        const start = Date.parse(msg.start_time);
        const stepMs = { '5minute': 300e3, hour: 3600e3, day: 86400e3, month: 30 * 86400e3 }[msg.period];
        for (const id of msg.statistic_ids) {
          const rows = [];
          for (let t = start; t < Date.now(); t += stepMs) {
            const d = new Date(t);
            if (msg.period === 'month') d.setDate(1);
            rows.push({ start: d.getTime(), end: d.getTime() + stepMs, change: Math.round(Math.random() * (msg.period === 'month' ? 50 : msg.period === 'day' ? 4 : 0.03) * 1000) / 1000 });
          }
          res[id] = rows;
        }
        ok(res);
        break;
      }
      default:
        send({ id: msg.id, type: 'result', success: false, error: { message: `Unknown command ${msg.type}` } });
    }
  }

  return new Promise((resolve) => server.listen(port, () => resolve({
    server,
    states,
    serviceCalls,
    setState(id, s) { states[id].s = String(s); pushChange(id); },
    close() { for (const c of sockets) c.socket.destroy(); server.close(); },
  })));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2] || 8123);
  await startMockHa(port);
  console.log(`Mock Home Assistant on :${port} (token "test")`);
}
