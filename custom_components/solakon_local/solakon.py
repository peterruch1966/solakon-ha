"""Discovers the Solakon ONE entities in Home Assistant and reads their live state."""

from __future__ import annotations

import logging
import math
from collections.abc import Callable
from typing import Any

from homeassistant.core import Event, HomeAssistant, callback
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import device_registry as dr, entity_registry as er
from homeassistant.helpers.event import async_track_state_change_event

from .const import SOLAKON_PLATFORM
from .devices import (
    ENERGY_SCALE,
    POWER_SCALE,
    device_info,
    find_device,
    pick_inverter,
    pick_meter,
    pick_wallbox,
    sensors_of,
)

_LOGGER = logging.getLogger(__name__)

EXTRA_KEYS = ("pvPower", "pvEnergy", "gridPower", "gridImportEnergy", "gridExportEnergy", "wallboxPower")


def key_from_unique_id(unique_id: str) -> str:
    """Entity unique IDs of the solakon_one integration are '<config_entry_id>_<key>'."""
    i = unique_id.find("_")
    return unique_id if i == -1 else unique_id[i + 1:]


def parse_value(state: str | None) -> Any:
    """Number when numeric, the raw string otherwise, None if unavailable."""
    if state is None or state in ("unavailable", "unknown", ""):
        return None
    try:
        return int(state)
    except ValueError:
        pass
    try:
        n = float(state)
    except ValueError:
        return state
    return n if math.isfinite(n) else state


def _entry_dict(e: er.RegistryEntry) -> dict:
    return {
        "entity_id": e.entity_id,
        "device_id": e.device_id,
        "disabled_by": e.disabled_by,
        "name": e.name,
        "original_name": e.original_name,
    }


def _device_dict(d: dr.DeviceEntry) -> dict:
    return {
        "id": d.id,
        "name": d.name,
        "name_by_user": d.name_by_user,
        "model": d.model,
        "manufacturer": d.manufacturer,
    }


class Solakon:
    def __init__(self, hass: HomeAssistant, get_settings: Callable[[], dict], device_id: str,
                 on_update: Callable[[], None]) -> None:
        self.hass = hass
        self.get_settings = get_settings
        self.device_id = device_id
        self.on_update = on_update
        self.key_to_entity: dict[str, str] = {}
        self.device: dict | None = None
        # Other devices: a separate PV inverter, the grid meter and a wallbox.
        self.extra: dict[str, str] = {k: "" for k in EXTRA_KEYS}
        self.extra_devices: dict[str, dict | None] = {"pv": None, "meter": None, "wallbox": None}
        self.extra_sensors: dict[str, list] = {"pv": [], "meter": [], "wallbox": []}
        self.discovery_error: str | None = None
        self.ready = False
        self._unsub: Callable[[], None] | None = None

    # --- discovery ---------------------------------------------------------------

    @callback
    def async_discover(self) -> None:
        ent_reg = er.async_get(self.hass)
        dev_reg = dr.async_get(self.hass)
        entries = list(ent_reg.entities.values())

        ours = [e for e in entries if e.platform == SOLAKON_PLATFORM and not e.disabled_by]
        if self.device_id:
            ours = [e for e in ours if e.device_id == self.device_id]
        device_ids = list(dict.fromkeys(e.device_id for e in ours))
        if len(device_ids) > 1:
            _LOGGER.warning("Found %s Solakon devices, using %s. Choose one in the integration options.",
                            len(device_ids), device_ids[0])
            ours = [e for e in ours if e.device_id == device_ids[0]]

        mapping = {key_from_unique_id(e.unique_id): e.entity_id for e in ours}
        mapping.update(self.get_settings().get("overrides") or {})
        self.key_to_entity = mapping

        d = dev_reg.async_get(device_ids[0]) if device_ids and device_ids[0] else None
        self.device = {
            "id": d.id,
            "name": d.name_by_user or d.name,
            "model": d.model,
            "modelId": getattr(d, "model_id", None),
            "serial": d.serial_number,
            "swVersion": d.sw_version,
            "manufacturer": d.manufacturer,
        } if d else None

        self._discover_extras([_entry_dict(e) for e in entries], [_device_dict(x) for x in dev_reg.devices.values()])
        self.discovery_error = None if ours else f'No entities of the "{SOLAKON_PLATFORM}" integration found in Home Assistant.'
        _LOGGER.info("Discovered %s Solakon entities", len(mapping))
        self._subscribe()
        self.ready = True
        self.on_update()

    def _discover_extras(self, entries: list[dict], devices: list[dict]) -> None:
        """Resolve the PV inverter, grid meter and wallbox sensors: manual entity settings win over auto-detection."""
        s = self.get_settings()
        names = s.get("devices") or {}
        pv = find_device(devices, names.get("pv"))
        # If no meter device matches by name, use the device of the configured grid power sensor.
        meter = find_device(devices, names.get("meter"))
        if not meter and s["entities"].get("gridPower"):
            dev_id = next((e["device_id"] for e in entries if e["entity_id"] == s["entities"]["gridPower"]), None)
            meter = next((d for d in devices if dev_id and d["id"] == dev_id), None)
        wallbox = find_device(devices, names.get("wallbox"))

        states = {
            st.entity_id: {"state": st.state, "attributes": dict(st.attributes)}
            for st in self.hass.states.async_all("sensor")
        } if (pv or meter or wallbox) else {}
        self.extra_devices = {"pv": device_info(pv), "meter": device_info(meter), "wallbox": device_info(wallbox)}
        self.extra_sensors = {
            "pv": sensors_of(entries, states, pv["id"]) if pv else [],
            "meter": sensors_of(entries, states, meter["id"]) if meter else [],
            "wallbox": sensors_of(entries, states, wallbox["id"]) if wallbox else [],
        }
        auto = {
            **pick_inverter(self.extra_sensors["pv"]),
            **pick_meter(self.extra_sensors["meter"]),
            **pick_wallbox(self.extra_sensors["wallbox"]),
        }
        self.extra = {k: s["entities"].get(k) or auto.get(k) or "" for k in EXTRA_KEYS}
        for key in ("pv", "meter", "wallbox"):
            if names.get(key) and not self.extra_devices[key]:
                _LOGGER.warning('Device "%s" not found in Home Assistant', names[key])
        _LOGGER.debug("Extra sensors: %s", self.extra)

    def watched_entity_ids(self) -> list[str]:
        ids = set(self.key_to_entity.values())
        ids.update(v for v in self.extra.values() if v)
        return sorted(i for i in ids if i)

    @callback
    def _subscribe(self) -> None:
        self.async_unsubscribe()
        ids = self.watched_entity_ids()
        if ids:
            self._unsub = async_track_state_change_event(self.hass, ids, self._on_state)

    @callback
    def _on_state(self, _event: Event) -> None:
        self.on_update()

    @callback
    def async_unsubscribe(self) -> None:
        if self._unsub:
            self._unsub()
            self._unsub = None

    # --- state -----------------------------------------------------------------------

    def entity_of(self, key: str) -> str | None:
        return self.key_to_entity.get(key)

    def get(self, key: str) -> Any:
        """Value of a Solakon key (number when numeric, string otherwise, None if unavailable)."""
        eid = self.key_to_entity.get(key)
        st = self.hass.states.get(eid) if eid else None
        return parse_value(st.state) if st else None

    def extra_value(self, key: str) -> float | None:
        """Value of an extra sensor in W (power) or kWh (energy), None if unavailable."""
        eid = self.extra.get(key)
        st = self.hass.states.get(eid) if eid else None
        v = parse_value(st.state) if st else None
        if not isinstance(v, (int, float)):
            return None
        unit = st.attributes.get("unit_of_measurement")
        return v * POWER_SCALE.get(unit, ENERGY_SCALE.get(unit, 1))

    def grid_power(self) -> float | None:
        """Grid power in W, positive = import."""
        v = self.extra_value("gridPower")
        if v is None:
            return None
        return -v if self.get_settings()["entities"].get("gridPowerInverted") else v

    def snapshot(self) -> dict:
        values: dict[str, Any] = {}
        meta: dict[str, dict] = {}
        for key, eid in self.key_to_entity.items():
            st = self.hass.states.get(eid)
            values[key] = parse_value(st.state) if st else None
            if st:
                a = st.attributes
                meta[key] = {
                    "entityId": eid,
                    "unit": a.get("unit_of_measurement"),
                    "min": a.get("min"),
                    "max": a.get("max"),
                    "step": a.get("step"),
                    "options": a.get("options"),
                }
        return {
            "device": self.device,
            "values": values,
            "meta": meta,
            "gridPower": self.grid_power(),
            "extra": {
                "devices": self.extra_devices,
                "entities": self.extra,
                **{k: self.extra_value(k) for k in ("pvPower", "pvEnergy", "gridImportEnergy", "gridExportEnergy", "wallboxPower")},
            },
            "discoveryError": self.discovery_error,
        }

    # --- commands ----------------------------------------------------------------------

    async def set_number(self, key: str, value: float) -> None:
        eid = self._require_entity(key, "number")
        await self.hass.services.async_call("number", "set_value", {"entity_id": eid, "value": value}, blocking=True)

    async def select_option(self, key: str, option: Any) -> None:
        eid = self._require_entity(key, "select")
        await self.hass.services.async_call("select", "select_option", {"entity_id": eid, "option": str(option)},
                                            blocking=True)

    def _require_entity(self, key: str, domain: str) -> str:
        eid = self.key_to_entity.get(key)
        if not eid or not eid.startswith(domain + "."):
            raise HomeAssistantError(f'Entity for "{key}" not found. Check that it is enabled in Home Assistant.')
        return eid
