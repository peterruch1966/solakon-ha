// Finds additional Home Assistant devices by name (a separate PV inverter and the grid meter)
// and picks their power and energy sensors.

export const POWER_SCALE = { W: 1, kW: 1000 }; // -> W
export const ENERGY_SCALE = { Wh: 0.001, kWh: 1, MWh: 1000 }; // -> kWh

// "sensor.powermeter_total_in" -> "sensor powermeter total in", so word boundaries work.
const norm = (s) => String(s || '').toLowerCase().replace(/[._\-/]+/g, ' ');

const PHASE = /\bphase\b|\bl[123]\b|\b[abc]\b|\bch(annel)? ?[1-9]\b|\bpv ?[1-9]\b|\bstring\b|\bdc\b/;
const NOT_ACTIVE_POWER = /reactive|apparent|blind|schein|limit|max|min|peak|average|avg/;
const DAILY = /day\b|daily|\btag|heute|week|month|year|monat|jahr/; // also matches OpenDTU "YieldDay"
const EXPORT = /export|return|einspeis|feed|lieferung|\b2 8 0\b|\bout\b|produc|sold|abgabe|erzeug/;
const IMPORT = /import|bezug|consum|verbrauch|\b1 8 0\b|\bin\b|delivered|purchas/;

export function findDevice(devices, name) {
  const want = norm(name).trim();
  if (!want) return null;
  const label = (d) => norm(d.name_by_user || d.name).trim();
  return devices.find((d) => label(d) === want)
    || devices.find((d) => norm(d.name).trim() === want)
    || devices.find((d) => label(d).includes(want))
    || null;
}

// Sensors of a device with the attributes needed to classify them.
export function sensorsOf(entries, states, deviceId) {
  const byId = new Map(states.map((s) => [s.entity_id, s]));
  return entries
    .filter((e) => e.device_id === deviceId && !e.disabled_by && e.entity_id.startsWith('sensor.'))
    .map((e) => {
      const a = byId.get(e.entity_id)?.attributes || {};
      return {
        entityId: e.entity_id,
        name: a.friendly_name || e.name || e.original_name || e.entity_id,
        unit: a.unit_of_measurement,
        deviceClass: a.device_class,
        stateClass: a.state_class,
        state: byId.get(e.entity_id)?.state,
      };
    })
    .filter((s) => s.unit in POWER_SCALE || s.unit in ENERGY_SCALE);
}

// Highest score wins; candidates scoring below zero are rejected.
function best(list, score) {
  let pick = null;
  let top = -1;
  for (const s of list) {
    const v = score(norm(`${s.entityId} ${s.name}`), s);
    if (v > top) { top = v; pick = s; }
  }
  return pick?.entityId || '';
}

const power = (list) => list.filter((s) => s.unit in POWER_SCALE);
const energy = (list) => list.filter((s) => s.unit in ENERGY_SCALE);

export function pickInverter(sensors) {
  return {
    pvPower: best(power(sensors), (n) => {
      if (NOT_ACTIVE_POWER.test(n) || PHASE.test(n)) return -1;
      return (/\bac\b/.test(n) ? 2 : 0) + (/power|leistung/.test(n) ? 1 : 0);
    }),
    pvEnergy: best(energy(sensors), (n, s) => {
      if (PHASE.test(n)) return -1;
      // A daily counter still works for statistics, but a lifetime one also gives the total.
      return (DAILY.test(n) ? 0 : 4) + (/total|gesamt|lifetime/.test(n) ? 2 : 0)
        + (s.stateClass === 'total_increasing' || s.stateClass === 'total' ? 1 : 0);
    }),
  };
}

export function pickMeter(sensors) {
  const counters = energy(sensors).filter((s) => !DAILY.test(norm(`${s.entityId} ${s.name}`)));
  return {
    gridPower: best(power(sensors), (n) => {
      if (NOT_ACTIVE_POWER.test(n) || PHASE.test(n)) return -1;
      return (/total|gesamt|sum|curr|aktuell|\bnet\b/.test(n) ? 2 : 0) + (/power|leistung/.test(n) ? 1 : 0);
    }),
    gridImportEnergy: best(counters, (n) => {
      if (PHASE.test(n) || EXPORT.test(n)) return -1;
      return (IMPORT.test(n) ? 2 : 0) + (/total|gesamt/.test(n) ? 1 : 0);
    }),
    gridExportEnergy: best(counters, (n) => {
      if (PHASE.test(n) || !EXPORT.test(n)) return -1;
      return /total|gesamt/.test(n) ? 1 : 0;
    }),
  };
}

export function deviceInfo(d) {
  return d ? { id: d.id, name: d.name_by_user || d.name, model: d.model, manufacturer: d.manufacturer } : null;
}
