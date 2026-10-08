# Solakon Local

A cloud-free replacement for the Solakon ONE app, as a Home Assistant integration. It adds a
**Solakon** panel to the HA sidebar and runs a local output control, using only the entities of
the official [Solakon ONE integration](https://github.com/solakon-de/solakon-one-homeassistant),
which reads the battery over Modbus TCP.

```
HA sidebar panel ──HA WebSocket──▶ Solakon Local (custom integration) ──HA entities──▶ Solakon ONE integration ──Modbus TCP──▶ Solakon ONE
```

## Features

| App area | What it does |
|---|---|
| **Übersicht / Home** | State of charge, charging/discharging, stored energy, live energy flow (solar, battery, home, grid), today's totals |
| **Statistik / Statistics** | Daily power and SoC curves for any day, energy per day (30 days) or month (12 months), with a table view |
| **Steuerung / Control** | Output control (device / constant power / zero export), time schedule, manual force charge/discharge, SoC limits, charge/discharge currents, export limit, backup (EPS/UPS) output |
| **Gerät / Device** | Model, serial, firmware, operating and remote-control status, PV strings, battery health, cell voltages, temperatures, grid values, energy counters |
| **Einstellungen / Settings** | Language (DE/EN or as in HA), smart meter selection, control tuning, discovered entities |

The panel follows the light/dark mode of your HA theme, updates live, and works in the HA
companion app. It is only shown to HA administrators.

### Additional devices: PV inverter, grid meter and wallbox

More Home Assistant devices are found **by their device name** (set in Settings → Other devices):

| Setting | Default | Used for |
|---|---|---|
| PV inverter | `Solaranlage Hoymiles` | Second power source in the energy flow, its power in the daily curve, its yield per day / month and in total |
| Power meter | `PowerMeter` | Grid power (energy flow, zero export) and **grid import / feed-in** today, per day / month, summed over the period, and the meter readings |
| Wallbox | `keba` | Charging power as its own consumer above the home in the energy flow (taken out of the home consumption) |

Their sensors (AC power, yield counter, import and export counters, charging power) are picked automatically;
if a guess is wrong, choose the sensor in Settings. Energy counters need long-term statistics in
HA (`state_class: total_increasing`), which most integrations provide.

### Output control (replacement for the app's cloud control)

| Mode | Behaviour |
|---|---|
| **Gerät / Device** | Solakon Local does not touch the device. |
| **Konstant / Constant** | Delivers a fixed power to the home (base load). |
| **Nulleinspeisung / Zero export** | Reads your smart meter every few seconds and adjusts the output so the grid power stays at a small import (default 10 W). |

Schedule entries (e.g. "22:00–06:00 constant 120 W") override the base mode; the first
matching entry wins.

The controller runs inside Home Assistant and uses the integration's remote-control entities
(mode *Inverter export (PV priority)*, power setpoint and timeout). It refreshes the timeout
while it runs, so **if Home Assistant or this integration stops, the device returns to its own
behaviour after the timeout** (default 120 s). Discharge is hard-capped at 800 W, force charge
at 1200 W, matching the integration.

## Requirements

- Home Assistant 2024.11 or newer
- The **Solakon ONE** integration set up and working
- Optional: a smart-meter power sensor in HA (Shelly 3EM, Tibber Pulse, IR reader, …) for zero export
  and the grid/home part of the energy flow.

## Installation

### HACS (recommended)

1. HACS → ⋮ → **Custom repositories** → add `https://github.com/peterruch1966/solakon-local`, type **Integration**.
2. Search for **Solakon Local** in HACS and download it.
3. Restart Home Assistant.
4. Settings → Devices & services → **Add integration** → **Solakon Local**.

### Manual

Copy `custom_components/solakon_local` into the `custom_components` folder of your HA
configuration, restart Home Assistant and add the integration as in step 4.

If you have more than one Solakon ONE, pick the device when adding the integration (or later
under *Configure*). The **Solakon** panel then appears in the sidebar.

Settings made in the panel are stored in HA (`.storage/solakon_local.settings`).

## Smart meter sign

The panel expects grid power **positive = import from the grid, negative = export**. If your meter
reports it the other way round, tick *"Vorzeichen umkehren"* in the settings. Check with the
*Aktuell / Now* value: at night with no PV it should be positive.

## Notes

- Statistics come from the Home Assistant recorder (history and long-term statistics), so the
  data range is whatever HA keeps (history: `purge_keep_days`, default 10 days; daily/monthly
  energy: unlimited).
- Manual force charge/discharge pauses the output control for its duration.
- If you switch the output control back to *Gerät/Device*, the remote-control mode is set back
  to *Disabled*.
- The Solakon cloud features (firmware updates, dynamic tariffs, the official app) are not
  replaced.

## Development

The control logic, settings validation and device matching have no Home Assistant imports and
are tested with the Python standard library:

```bash
python3 -m unittest discover -s tests -t .
```
