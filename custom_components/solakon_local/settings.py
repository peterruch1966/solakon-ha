"""User settings of the panel: defaults, merging and validation (no Home Assistant imports)."""

from __future__ import annotations

import copy
import math
import re
from typing import Any

from .const import HARD_MAX_OUTPUT_W

DEFAULT_SETTINGS: dict[str, Any] = {
    # Other HA devices, found by name: a separate PV inverter, the grid meter, a wallbox and a heat pump.
    # Their sensors are picked automatically unless set below in `entities`.
    "devices": {
        "pv": "Solaranlage Hoymiles",
        "meter": "PowerMeter",
        "wallbox": "keba",
        "heatpump": "e3_vitocal_16",
    },
    # Extra HA entities that are not part of the Solakon integration. Empty = auto-detect from `devices`.
    "entities": {
        # Smart meter power at the grid connection point (W). Used for zero feed-in and the energy flow.
        "gridPower": "sensor.power_goethestrasse_8_total_active_power",
        # Set to true if the meter reports export as positive / import as negative.
        "gridPowerInverted": False,
        # Grid meter energy counters (kWh): import from and export (feed-in) to the grid.
        "gridImportEnergy": "",
        "gridExportEnergy": "",
        # Separate PV inverter: AC power (W) and yield counter (kWh).
        "pvPower": "",
        "pvEnergy": "",
        # Wallbox charging power (W).
        "wallboxPower": "",
        # Heat pump electrical power (W).
        "heatpumpPower": "",
    },
    # Manual entity overrides: { solakonKey: entity_id }
    "overrides": {},
    "control": {
        # off: integration does not touch the device | constant: fixed output | zero: zero feed-in via smart meter
        "mode": "off",
        "constantW": 200,
        "zero": {
            "targetGridW": 10,  # aim for this small grid import to avoid exporting
            "deadbandW": 15,
            "intervalS": 5,
            "smoothing": 0.6,  # 0..1, share of the correction applied per cycle
        },
        "maxOutputW": 800,
        "remoteMode": "1",  # Inverter export (PV priority)
        "timeoutS": 120,  # device falls back to its own logic if the controller stops refreshing
        "schedule": [],  # [{ enabled, days:[0-6], start:'HH:MM', end:'HH:MM', mode:'constant'|'zero'|'off', watts }]
    },
}

MODES = ("off", "constant", "zero")
_TIME = re.compile(r"\d{1,2}:\d{2}")


class SettingsError(ValueError):
    """Invalid user input."""


def deep_merge(base: Any, extra: Any) -> Any:
    """Merge `extra` into a copy of `base`; nested dicts are merged, everything else (lists too) is replaced."""
    if not isinstance(base, dict):
        return copy.deepcopy(base if extra is None else extra)
    out = copy.deepcopy(base)
    if not isinstance(extra, dict):
        return out
    for k, v in extra.items():
        out[k] = deep_merge(base[k], v) if isinstance(base.get(k), dict) else copy.deepcopy(v)
    return out


def num(value: Any, lo: float, hi: float, name: str) -> int | float:
    try:
        n = float(value)
    except (TypeError, ValueError):
        n = math.nan
    if isinstance(value, bool) or not math.isfinite(n) or n < lo or n > hi:
        raise SettingsError(f"{name} must be between {lo} and {hi}")
    return int(n) if n.is_integer() else n


def validate(settings: dict, has_grid_power: bool) -> None:
    """Check and normalise the control settings in place."""
    c = settings["control"]
    if c.get("mode") not in MODES:
        raise SettingsError("Invalid mode")
    c["maxOutputW"] = num(c.get("maxOutputW"), 0, HARD_MAX_OUTPUT_W, "Max output")
    c["constantW"] = num(c.get("constantW"), 0, c["maxOutputW"], "Constant output")
    c["timeoutS"] = num(c.get("timeoutS"), 30, 3600, "Timeout")
    z = c["zero"]
    z["intervalS"] = num(z.get("intervalS"), 2, 60, "Interval")
    z["smoothing"] = num(z.get("smoothing"), 0.05, 1, "Smoothing")
    z["deadbandW"] = num(z.get("deadbandW"), 0, 200, "Deadband")
    z["targetGridW"] = num(z.get("targetGridW"), -200, 500, "Grid target")
    if not isinstance(c.get("schedule"), list):
        raise SettingsError("Invalid schedule")
    for e in c["schedule"]:
        if not isinstance(e, dict) or not _TIME.fullmatch(str(e.get("start", ""))) or not _TIME.fullmatch(str(e.get("end", ""))):
            raise SettingsError("Invalid schedule time")
        if e.get("mode") not in MODES:
            raise SettingsError("Invalid schedule mode")
        e["watts"] = num(e.get("watts") if e.get("watts") is not None else 0, 0, c["maxOutputW"], "Schedule power")
    if c["mode"] == "zero" and not has_grid_power:
        raise SettingsError("Zero feed-in needs a smart meter entity (Settings → Smart meter).")
