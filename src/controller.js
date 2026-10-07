// Local output control, replacing the cloud-based control of the Solakon app.
//
// The device is driven through the remote control registers exposed by the
// solakon_one integration: a remote control mode, an active power setpoint and a
// timeout. The timeout is refreshed while the controller runs, so if this app stops
// the device falls back to its own behaviour after `timeoutS` seconds.

export const HARD_MAX_OUTPUT_W = 800; // the device must never be asked to discharge more

function minutes(hhmm) {
  const [h, m] = String(hhmm || '0:0').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

export function activeScheduleEntry(schedule, now = new Date()) {
  const day = now.getDay();
  const t = now.getHours() * 60 + now.getMinutes();
  for (const e of schedule || []) {
    if (e.enabled === false) continue;
    const start = minutes(e.start);
    const end = minutes(e.end);
    const days = e.days?.length ? e.days : [0, 1, 2, 3, 4, 5, 6];
    if (start <= end) {
      if (days.includes(day) && t >= start && t < end) return e;
    } else {
      // Window crosses midnight: the part after midnight belongs to the previous day's entry.
      if ((days.includes(day) && t >= start) || (days.includes((day + 6) % 7) && t < end)) return e;
    }
  }
  return null;
}

export function zeroFeedInTarget({ gridW, outputW, lastTargetW, cfg, maxW }) {
  const base = typeof outputW === 'number' ? outputW : lastTargetW;
  const error = gridW - cfg.targetGridW; // >0: importing more than wanted -> raise output
  const next = base + error * cfg.smoothing;
  return Math.round(Math.max(0, Math.min(maxW, next)));
}

export class Controller {
  constructor(solakon, getSettings, log = console) {
    this.solakon = solakon;
    this.getSettings = getSettings;
    this.log = log;
    this.timer = null;
    this.busy = false;
    this.managing = false;
    this.lastTargetW = 0;
    this.lastSentW = null;
    this.lastTimeoutWrite = 0;
    this.pausedUntil = 0;
    this.status = { mode: 'off', source: 'settings', targetW: null, error: null, lastWrite: null };
  }

  start() {
    this.stop();
    const tick = async () => {
      await this.tick().catch((err) => {
        this.status.error = err.message;
        this.log.error('Controller:', err.message);
      });
      this.timer = setTimeout(tick, this.intervalMs());
    };
    this.timer = setTimeout(tick, 2000);
  }

  stop() {
    clearTimeout(this.timer);
    this.timer = null;
  }

  intervalMs() {
    const c = this.getSettings().control;
    return Math.max(2, Number(c.zero.intervalS) || 5) * 1000;
  }

  effectiveMode() {
    const c = this.getSettings().control;
    const entry = activeScheduleEntry(c.schedule);
    if (entry) return { mode: entry.mode, watts: Number(entry.watts) || 0, source: 'schedule' };
    return { mode: c.mode, watts: Number(c.constantW) || 0, source: 'settings' };
  }

  async tick() {
    if (this.busy || !this.solakon.ha.connected) return;
    this.busy = true;
    try {
      await this.run();
    } finally {
      this.busy = false;
    }
  }

  async run() {
    const c = this.getSettings().control;
    if (Date.now() < this.pausedUntil) {
      // A manual force charge/discharge owns the remote control registers right now.
      this.status = { ...this.status, mode: 'paused', pausedUntil: new Date(this.pausedUntil).toISOString() };
      this.managing = false;
      return;
    }
    delete this.status.pausedUntil;
    const { mode, watts, source } = this.effectiveMode();
    const maxW = Math.min(HARD_MAX_OUTPUT_W, Number(c.maxOutputW) || HARD_MAX_OUTPUT_W);
    this.status.mode = mode;
    this.status.source = source;

    if (mode === 'off') {
      if (this.managing) await this.release();
      this.status.targetW = null;
      this.status.error = null;
      return;
    }

    let target;
    if (mode === 'constant') {
      target = Math.max(0, Math.min(maxW, Math.round(watts)));
    } else if (mode === 'zero') {
      const gridW = this.solakon.gridPower();
      if (gridW === null) {
        this.status.error = 'No smart meter value – configure the grid power entity in settings.';
        target = 0;
      } else {
        this.status.error = null;
        target = zeroFeedInTarget({
          gridW,
          outputW: this.solakon.get('active_power'),
          lastTargetW: this.lastTargetW,
          cfg: c.zero,
          maxW,
        });
      }
    } else {
      throw new Error(`Unknown control mode "${mode}"`);
    }

    this.lastTargetW = target;
    this.status.targetW = target;
    await this.apply(target, c);
  }

  async apply(targetW, c) {
    const s = this.solakon;
    const deadband = Number(c.zero.deadbandW) || 0;
    const modeOk = String(s.get('remote_control_mode')) === String(c.remoteMode);
    const now = Date.now();

    if (!modeOk || this.lastSentW === null || Math.abs(targetW - this.lastSentW) >= deadband
        || (targetW === 0 && this.lastSentW !== 0)) {
      // Write the setpoint before enabling the mode so it never starts with a stale, higher value.
      await s.setNumber('remote_active_power', targetW);
      this.lastSentW = targetW;
      this.status.lastWrite = new Date().toISOString();
    }
    if (!modeOk || now - this.lastTimeoutWrite > (c.timeoutS * 1000) / 3) {
      await s.setNumber('remote_timeout_set', c.timeoutS);
      this.lastTimeoutWrite = now;
    }
    if (!modeOk) {
      this.log.info(`Enabling remote control mode ${c.remoteMode}`);
      await s.selectOption('remote_control_mode', c.remoteMode);
    }
    this.managing = true;
  }

  async release() {
    this.log.info('Releasing remote control');
    await this.solakon.selectOption('remote_control_mode', '0');
    this.managing = false;
    this.lastSentW = null;
    this.lastTimeoutWrite = 0;
  }

  pause(ms) {
    this.pausedUntil = ms > 0 ? Date.now() + ms : 0;
    this.lastSentW = null;
    this.lastTimeoutWrite = 0;
  }

  // Called when settings change so a new mode takes effect immediately.
  async kick() {
    this.lastSentW = null;
    await this.tick().catch((err) => {
      this.status.error = err.message;
    });
  }
}
