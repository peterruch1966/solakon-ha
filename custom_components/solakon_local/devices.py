"""Find additional Home Assistant devices by name and pick their power and energy sensors.

Covers a separate PV inverter, the grid meter and a wallbox. Devices, registry entries and
states are passed in as plain dicts, so this module has no Home Assistant dependency.
"""

from __future__ import annotations

import re
from typing import Any

POWER_SCALE = {"W": 1, "kW": 1000}  # -> W
ENERGY_SCALE = {"Wh": 0.001, "kWh": 1, "MWh": 1000}  # -> kWh

PHASE = re.compile(r"\bphase\b|\bl[123]\b|\b[abc]\b|\bch(annel)? ?[1-9]\b|\bpv ?[1-9]\b|\bstring\b|\bdc\b")
NOT_ACTIVE_POWER = re.compile(r"reactive|apparent|blind|schein|limit|max|min|peak|average|avg")
DAILY = re.compile(r"day\b|daily|\btag|heute|week|month|year|monat|jahr")  # also matches OpenDTU "YieldDay"
EXPORT = re.compile(r"export|return|einspeis|feed|lieferung|\b2 8 0\b|\bout\b|produc|sold|abgabe|erzeug")
IMPORT = re.compile(r"import|bezug|consum|verbrauch|\b1 8 0\b|\bin\b|delivered|purchas")


def norm(s: Any) -> str:
    """'sensor.powermeter_total_in' -> 'sensor powermeter total in', so word boundaries work."""
    return re.sub(r"[._\-/]+", " ", str(s or "").lower())


def find_device(devices: list[dict], name: str | None) -> dict | None:
    want = norm(name).strip()
    if not want:
        return None

    def label(d: dict) -> str:
        return norm(d.get("name_by_user") or d.get("name")).strip()

    for test in (
        lambda d: label(d) == want,
        lambda d: norm(d.get("name")).strip() == want,
        lambda d: want in label(d),
    ):
        for d in devices:
            if test(d):
                return d
    return None


def sensors_of(entries: list[dict], states: dict[str, dict], device_id: str) -> list[dict]:
    """Sensors of a device with the attributes needed to classify them."""
    out = []
    for e in entries:
        eid = e["entity_id"]
        if e.get("device_id") != device_id or e.get("disabled_by") or not eid.startswith("sensor."):
            continue
        st = states.get(eid) or {}
        a = st.get("attributes") or {}
        unit = a.get("unit_of_measurement")
        if unit not in POWER_SCALE and unit not in ENERGY_SCALE:
            continue
        out.append({
            "entityId": eid,
            "name": a.get("friendly_name") or e.get("name") or e.get("original_name") or eid,
            "unit": unit,
            "deviceClass": a.get("device_class"),
            "stateClass": a.get("state_class"),
            "state": st.get("state"),
        })
    return out


def _best(sensors: list[dict], score) -> str:
    """Highest score wins; candidates scoring below zero are rejected."""
    pick = None
    top = -1
    for s in sensors:
        v = score(norm(f"{s['entityId']} {s['name']}"), s)
        if v > top:
            top = v
            pick = s
    return pick["entityId"] if pick else ""


def _power(sensors: list[dict]) -> list[dict]:
    return [s for s in sensors if s["unit"] in POWER_SCALE]


def _energy(sensors: list[dict]) -> list[dict]:
    return [s for s in sensors if s["unit"] in ENERGY_SCALE]


def _has(pattern: str, n: str) -> bool:
    return re.search(pattern, n) is not None


def pick_inverter(sensors: list[dict]) -> dict[str, str]:
    def power(n, _s):
        if NOT_ACTIVE_POWER.search(n) or PHASE.search(n):
            return -1
        return (2 if _has(r"\bac\b", n) else 0) + (1 if _has(r"power|leistung", n) else 0)

    def energy(n, s):
        if PHASE.search(n):
            return -1
        # A daily counter still works for statistics, but a lifetime one also gives the total.
        return ((0 if DAILY.search(n) else 4)
                + (2 if _has(r"total|gesamt|lifetime", n) else 0)
                + (1 if s.get("stateClass") in ("total_increasing", "total") else 0))

    return {"pvPower": _best(_power(sensors), power), "pvEnergy": _best(_energy(sensors), energy)}


def pick_meter(sensors: list[dict]) -> dict[str, str]:
    counters = [s for s in _energy(sensors) if not DAILY.search(norm(f"{s['entityId']} {s['name']}"))]

    def power(n, _s):
        if NOT_ACTIVE_POWER.search(n) or PHASE.search(n):
            return -1
        return (2 if _has(r"total|gesamt|sum|curr|aktuell|\bnet\b", n) else 0) + (1 if _has(r"power|leistung", n) else 0)

    def imp(n, _s):
        if PHASE.search(n) or EXPORT.search(n):
            return -1
        return (2 if IMPORT.search(n) else 0) + (1 if _has(r"total|gesamt", n) else 0)

    def exp(n, _s):
        if PHASE.search(n) or not EXPORT.search(n):
            return -1
        return 1 if _has(r"total|gesamt", n) else 0

    return {
        "gridPower": _best(_power(sensors), power),
        "gridImportEnergy": _best(counters, imp),
        "gridExportEnergy": _best(counters, exp),
    }


def pick_wallbox(sensors: list[dict]) -> dict[str, str]:
    """Wallbox (e.g. KEBA): the power currently drawn by the car charger."""
    def power(n, _s):
        if NOT_ACTIVE_POWER.search(n) or PHASE.search(n):
            return -1
        return (2 if _has(r"charg|lade", n) else 0) + (1 if _has(r"power|leistung", n) else 0)

    return {"wallboxPower": _best(_power(sensors), power)}


def device_info(d: dict | None) -> dict | None:
    if not d:
        return None
    return {
        "id": d.get("id"),
        "name": d.get("name_by_user") or d.get("name"),
        "model": d.get("model"),
        "manufacturer": d.get("manufacturer"),
    }
