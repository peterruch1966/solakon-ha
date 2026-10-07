// Runtime configuration: environment variables plus user settings persisted in DATA_DIR.
import fs from 'node:fs';
import path from 'node:path';

export const env = {
  port: Number(process.env.PORT || 8099),
  haUrl: (process.env.HA_URL || 'http://homeassistant:8123').replace(/\/+$/, ''),
  haToken: process.env.HA_TOKEN || '',
  dataDir: process.env.DATA_DIR || '/data',
  // Optional: protect the UI with a password (HTTP basic auth, user name is ignored).
  appPassword: process.env.APP_PASSWORD || '',
  // Optional: pin a specific Solakon device if more than one is configured in HA.
  deviceId: process.env.SOLAKON_DEVICE_ID || '',
};

export const DEFAULT_SETTINGS = {
  language: 'de',
  // Extra HA entities that are not part of the Solakon integration.
  entities: {
    // Smart meter power at the grid connection point (W). Used for zero feed-in and the energy flow.
    gridPower: '',
    // Set to true if the meter reports export as positive / import as negative.
    gridPowerInverted: false,
  },
  // Manual entity overrides: { solakonKey: entity_id }
  overrides: {},
  control: {
    // off: app does not touch the device | constant: fixed output | zero: zero feed-in via smart meter
    mode: 'off',
    constantW: 200,
    zero: {
      targetGridW: 10, // aim for this small grid import to avoid exporting
      deadbandW: 15,
      intervalS: 5,
      smoothing: 0.6, // 0..1, share of the correction applied per cycle
    },
    maxOutputW: 800,
    remoteMode: '1', // Inverter export (PV priority)
    timeoutS: 120, // device falls back to its own logic if the app stops refreshing
    schedule: [], // [{ enabled, days:[0-6], start:'HH:MM', end:'HH:MM', mode:'constant'|'zero'|'off', watts }]
  },
};

const settingsFile = () => path.join(env.dataDir, 'settings.json');

function deepMerge(base, extra) {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) {
    return extra === undefined ? base : extra;
  }
  const out = { ...base };
  for (const [k, v] of Object.entries(extra || {})) {
    out[k] = k in base && typeof base[k] === 'object' && !Array.isArray(base[k]) && base[k] !== null
      ? deepMerge(base[k], v)
      : v;
  }
  return out;
}

export function loadSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    return deepMerge(DEFAULT_SETTINGS, raw);
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

export function saveSettings(settings) {
  fs.mkdirSync(env.dataDir, { recursive: true });
  const tmp = settingsFile() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2));
  fs.renameSync(tmp, settingsFile());
}

export function mergeSettings(current, patch) {
  return deepMerge(current, patch);
}
