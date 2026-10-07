# Solakon Local

A cloud-free replacement for the Solakon ONE app. It runs as a Docker container on a
Raspberry Pi and talks only to your local Home Assistant, which reads the battery over
Modbus TCP using the official [Solakon ONE integration](https://github.com/solakon-de/solakon-one-homeassistant).

```
Browser / phone ──HTTP──▶ Solakon Local (this container) ──WebSocket──▶ Home Assistant ──Modbus TCP──▶ Solakon ONE
```

## Features

| App area | What it does |
|---|---|
| **Übersicht / Home** | State of charge, charging/discharging, stored energy, live energy flow (solar, battery, home, grid), today's totals |
| **Statistik / Statistics** | Daily power and SoC curves for any day, energy per day (30 days) or month (12 months), with a table view |
| **Steuerung / Control** | Output control (device / constant power / zero export), time schedule, manual force charge/discharge, SoC limits, charge/discharge currents, export limit, backup (EPS/UPS) output |
| **Gerät / Device** | Model, serial, firmware, operating and remote-control status, PV strings, battery health, cell voltages, temperatures, grid values, energy counters |
| **Einstellungen / Settings** | Language (DE/EN), theme, smart meter selection, control tuning, discovered entities |

### Additional devices: PV inverter and grid meter

Two more Home Assistant devices are found **by their device name** (set in Settings → Other devices):

| Setting | Default | Used for |
|---|---|---|
| PV inverter | `Solaranlage Hoymiles` | Second power source in the energy flow, its power in the daily curve, its yield per day / month and in total |
| Power meter | `PowerMeter` | Grid power (energy flow, zero export) and **grid import / feed-in** today, per day / month, summed over the period, and the meter readings |

Their sensors (AC power, yield counter, import and export counters) are picked automatically;
if a guess is wrong, choose the sensor in Settings. Energy counters need long-term statistics in
HA (`state_class: total_increasing`), which most integrations provide.

Live values update over a push stream (no page refresh needed). The UI is installable as a
home-screen app (PWA) and loads nothing from the internet.

### Output control (replacement for the app's cloud control)

| Mode | Behaviour |
|---|---|
| **Gerät / Device** | This app does not touch the device. |
| **Konstant / Constant** | Delivers a fixed power to the home (base load). |
| **Nulleinspeisung / Zero export** | Reads your smart meter from Home Assistant every few seconds and adjusts the output so the grid power stays at a small import (default 10 W). |

Schedule entries (e.g. "22:00–06:00 constant 120 W") override the base mode; the first
matching entry wins.

The controller uses the integration's remote-control entities (mode *Inverter export (PV
priority)*, power setpoint and timeout). It refreshes the timeout while it runs, so **if this
container stops, the device returns to its own behaviour after the timeout** (default 120 s).
Discharge is hard-capped at 800 W, force charge at 1200 W, matching the integration.

## Requirements

- Home Assistant with the **Solakon ONE** integration (HACS) set up and working
- A **long-lived access token** of an HA **admin** user (HA → Profile → Security → Long-lived access tokens).
  Admin is required to read the entity registry, which is how the app finds the Solakon entities
  regardless of language or renamed entity IDs.
- Optional: a smart-meter power sensor in HA (Shelly 3EM, Tibber Pulse, IR reader, …) for zero export
  and the grid/home part of the energy flow.

## Install on the Raspberry Pi

```bash
git clone <this repo> solakon-local   # or copy the folder to the Pi
cd solakon-local
cp .env.example .env
nano .env                              # set HA_URL and HA_TOKEN
docker compose up -d --build
```

Open `http://<pi-ip>:8099`.

### Which `HA_URL`?

| Home Assistant runs… | `HA_URL` |
|---|---|
| in Docker with `network_mode: host` on the same Pi (the usual setup) | `http://172.17.0.1:8123` or `http://<pi-lan-ip>:8123` |
| in Docker on a shared user-defined network with this container | `http://homeassistant:8123` (container name) |
| on another machine | `http://<that-ip>:8123` |

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `HA_URL` | `http://homeassistant:8123` | Home Assistant base URL |
| `HA_TOKEN` | – | Long-lived access token (admin) |
| `PORT` | `8099` | Web UI port |
| `TZ` | `Europe/Berlin` | Time zone for schedules and day charts |
| `APP_PASSWORD` | – | If set, the UI asks for this password (HTTP basic auth, any user name) |
| `SOLAKON_DEVICE_ID` | – | HA device ID, only needed with more than one Solakon device |

Settings made in the UI are stored in `./data/settings.json`.

## Smart meter sign

The app expects grid power **positive = import from the grid, negative = export**. If your meter
reports it the other way round, tick *"Vorzeichen umkehren"* in the settings. Check with the
*Aktuell / Now* value: at night with no PV it should be positive.

## Notes

- Statistics come from the Home Assistant recorder (history and long-term statistics), so the
  data range is whatever HA keeps (history: `purge_keep_days`, default 10 days; daily/monthly
  energy: unlimited).
- Manual force charge/discharge pauses the output control for its duration.
- If you switch the output control back to *Gerät/Device*, the app sets the remote-control mode
  back to *Disabled*.
- The Solakon cloud features (firmware updates, dynamic tariffs, the official app) are not
  replaced.

## Development

```bash
node test/mock-ha.js 8123                       # fake Home Assistant, token "test"
HA_URL=http://127.0.0.1:8123 HA_TOKEN=test DATA_DIR=./data npm start
npm test                                        # unit + end-to-end tests (no dependencies)
```
