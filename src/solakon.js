// Discovers the Solakon ONE entities in Home Assistant and keeps their live state.
import { EventEmitter } from 'node:events';

const PLATFORM = 'solakon_one';

// Entity unique IDs of the solakon_one integration are "<config_entry_id>_<key>".
function keyFromUniqueId(uniqueId) {
  const i = uniqueId.indexOf('_');
  return i === -1 ? uniqueId : uniqueId.slice(i + 1);
}

function parseValue(state) {
  if (state === undefined || state === null) return null;
  if (state === 'unavailable' || state === 'unknown') return null;
  const n = Number(state);
  return state !== '' && Number.isFinite(n) ? n : state;
}

export class Solakon extends EventEmitter {
  constructor(ha, getSettings, opts = {}, log = console) {
    super();
    this.ha = ha;
    this.getSettings = getSettings;
    this.deviceId = opts.deviceId || '';
    this.log = log;
    this.keyToEntity = {}; // solakon key -> entity_id
    this.entities = {}; // entity_id -> { state, attributes, lastUpdated }
    this.device = null;
    this.discoveryError = null;
    this.subId = null;

    ha.on('connected', () => this.init().catch((err) => {
      this.discoveryError = err.message;
      this.log.error('Discovery failed:', err.message);
      this.emit('update');
    }));
  }

  async init() {
    await this.discover();
    await this.subscribe();
  }

  async discover() {
    let entries;
    try {
      entries = await this.ha.send({ type: 'config/entity_registry/list' });
    } catch (err) {
      throw new Error(`Cannot read entity registry (token must belong to an admin user): ${err.message}`);
    }
    let ours = entries.filter((e) => e.platform === PLATFORM && !e.disabled_by);
    if (this.deviceId) ours = ours.filter((e) => e.device_id === this.deviceId);
    const deviceIds = [...new Set(ours.map((e) => e.device_id))];
    if (deviceIds.length > 1) {
      this.log.warn(`Found ${deviceIds.length} Solakon devices, using ${deviceIds[0]}. Set SOLAKON_DEVICE_ID to choose.`);
      ours = ours.filter((e) => e.device_id === deviceIds[0]);
    }

    const map = {};
    for (const e of ours) map[keyFromUniqueId(e.unique_id)] = e.entity_id;
    Object.assign(map, this.getSettings().overrides || {});
    this.keyToEntity = map;

    if (deviceIds[0]) {
      try {
        const devices = await this.ha.send({ type: 'config/device_registry/list' });
        const d = devices.find((x) => x.id === deviceIds[0]);
        if (d) {
          this.device = {
            id: d.id,
            name: d.name_by_user || d.name,
            model: d.model,
            modelId: d.model_id,
            serial: d.serial_number,
            swVersion: d.sw_version,
            manufacturer: d.manufacturer,
          };
        }
      } catch (err) {
        this.log.warn('Could not read device registry:', err.message);
      }
    }

    this.discoveryError = ours.length ? null
      : `No entities of the "${PLATFORM}" integration found in Home Assistant.`;
    this.log.info(`Discovered ${Object.keys(map).length} Solakon entities`);
  }

  watchedEntityIds() {
    const s = this.getSettings();
    const ids = new Set(Object.values(this.keyToEntity));
    if (s.entities.gridPower) ids.add(s.entities.gridPower);
    return [...ids].filter(Boolean);
  }

  async subscribe() {
    const ids = this.watchedEntityIds();
    if (!ids.length) {
      this.emit('update');
      return;
    }
    this.entities = {};
    // subscribe_entities sends a full snapshot first, then compressed diffs.
    // Resolve once the snapshot is in, so callers never act on empty state.
    let gotSnapshot;
    const snapshot = new Promise((resolve) => { gotSnapshot = resolve; });
    this.subId = await this.ha.subscribe(
      { type: 'subscribe_entities', entity_ids: ids },
      (ev) => {
        this.onEntities(ev);
        gotSnapshot();
      },
    );
    await Promise.race([snapshot, new Promise((r) => setTimeout(r, 5000))]);
  }

  async resubscribe() {
    if (!this.ha.connected) return;
    if (this.subId !== null) {
      await this.ha.send({ type: 'unsubscribe_events', subscription: this.subId }).catch(() => {});
      this.ha.subscriptions.delete(this.subId);
      this.subId = null;
    }
    await this.init();
  }

  onEntities(ev) {
    for (const [id, s] of Object.entries(ev.a || {})) {
      this.entities[id] = { state: s.s, attributes: s.a || {}, lastUpdated: s.lu ?? s.lc };
    }
    for (const [id, diff] of Object.entries(ev.c || {})) {
      const cur = this.entities[id] || { state: null, attributes: {} };
      const plus = diff['+'] || {};
      if ('s' in plus) cur.state = plus.s;
      if (plus.a) cur.attributes = { ...cur.attributes, ...plus.a };
      if (plus.lu || plus.lc) cur.lastUpdated = plus.lu ?? plus.lc;
      for (const k of diff['-']?.a || []) delete cur.attributes[k];
      this.entities[id] = cur;
    }
    for (const id of ev.r || []) delete this.entities[id];
    this.emit('update');
  }

  entityOf(key) {
    return this.keyToEntity[key];
  }

  // Value of a Solakon key (number when numeric, string otherwise, null if unavailable).
  get(key) {
    const id = this.keyToEntity[key];
    return id ? parseValue(this.entities[id]?.state) : null;
  }

  gridPower() {
    const s = this.getSettings();
    if (!s.entities.gridPower) return null;
    const ent = this.entities[s.entities.gridPower];
    let v = parseValue(ent?.state);
    if (typeof v !== 'number') return null;
    if (ent.attributes?.unit_of_measurement === 'kW') v *= 1000;
    return s.entities.gridPowerInverted ? -v : v;
  }

  snapshot() {
    const values = {};
    const meta = {};
    for (const [key, id] of Object.entries(this.keyToEntity)) {
      const ent = this.entities[id];
      values[key] = parseValue(ent?.state);
      if (ent) {
        meta[key] = {
          entityId: id,
          unit: ent.attributes.unit_of_measurement,
          min: ent.attributes.min,
          max: ent.attributes.max,
          step: ent.attributes.step,
          options: ent.attributes.options,
        };
      }
    }
    return {
      device: this.device,
      values,
      meta,
      gridPower: this.gridPower(),
      discoveryError: this.discoveryError,
    };
  }

  // --- Commands --------------------------------------------------------------

  async setNumber(key, value) {
    const id = this.requireEntity(key, 'number');
    await this.ha.callService('number', 'set_value', id, { value });
  }

  async selectOption(key, option) {
    const id = this.requireEntity(key, 'select');
    await this.ha.callService('select', 'select_option', id, { option: String(option) });
  }

  requireEntity(key, domain) {
    const id = this.keyToEntity[key];
    if (!id || !id.startsWith(domain + '.')) {
      throw new Error(`Entity for "${key}" not found. Check that it is enabled in Home Assistant.`);
    }
    return id;
  }
}
