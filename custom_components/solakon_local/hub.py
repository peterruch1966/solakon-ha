"""Runtime of one Solakon Local config entry: settings, discovery, controller and live updates."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable
from typing import Any

from homeassistant.core import HomeAssistant, callback
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.storage import Store
from homeassistant.util import dt as dt_util

from .const import DOMAIN, HARD_MAX_OUTPUT_W, MAX_CHARGE_W, NUMBER_LIMITS, SELECT_OPTIONS
from .controller import Controller
from .settings import DEFAULT_SETTINGS, SettingsError, deep_merge, num, validate
from .solakon import Solakon

_LOGGER = logging.getLogger(__name__)

STORAGE_VERSION = 1
PUSH_DELAY_S = 0.3


class InvalidInput(HomeAssistantError):
    """Rejected user input; the message is shown in the panel."""


def _checked(fn: Callable[[], Any]) -> Any:
    try:
        return fn()
    except SettingsError as err:
        raise InvalidInput(str(err)) from err


class Hub:
    def __init__(self, hass: HomeAssistant, device_id: str, listeners: set[Callable[[dict], None]]) -> None:
        self.hass = hass
        self.settings: dict = deep_merge(DEFAULT_SETTINGS, {})
        self._store: Store[dict] = Store(hass, STORAGE_VERSION, f"{DOMAIN}.settings")
        # Panel subscriptions live outside the hub, so they survive a reload of the config entry.
        self._listeners = listeners
        self._push_handle: asyncio.TimerHandle | None = None
        self.solakon = Solakon(hass, lambda: self.settings, device_id, self.schedule_push)
        self.controller = Controller(self.solakon, lambda: self.settings, now=dt_util.now)

    async def async_load(self) -> None:
        raw = await self._store.async_load()
        if raw:
            self.settings = deep_merge(DEFAULT_SETTINGS, raw)

    @callback
    def async_shutdown(self) -> None:
        if self._push_handle:
            self._push_handle.cancel()
            self._push_handle = None
        self.solakon.async_unsubscribe()

    # --- live updates ----------------------------------------------------------------

    def state(self) -> dict:
        return {
            **self.solakon.snapshot(),
            "controller": dict(self.controller.status),
            "settings": self.settings,
            "serverTime": dt_util.utcnow().isoformat(),
        }

    @callback
    def schedule_push(self) -> None:
        if self._push_handle or not self._listeners:
            return
        self._push_handle = self.hass.loop.call_later(PUSH_DELAY_S, self._push)

    @callback
    def _push(self) -> None:
        self._push_handle = None
        state = self.state()
        for listener in list(self._listeners):
            listener(state)

    # --- commands ----------------------------------------------------------------------

    def device_sensors(self) -> dict:
        """Sensors of the extra devices, for choosing them manually in the settings."""
        return {
            "devices": self.solakon.extra_devices,
            "sensors": self.solakon.extra_sensors,
            "entities": self.solakon.extra,
        }

    async def async_set_number(self, key: str, value: Any) -> None:
        if key not in NUMBER_LIMITS:
            raise InvalidInput("Setting not allowed")
        lo, hi = NUMBER_LIMITS[key]
        await self.solakon.set_number(key, _checked(lambda: num(value, lo, hi, key)))

    async def async_select_option(self, key: str, option: Any) -> None:
        if str(option) not in SELECT_OPTIONS.get(key, ()):
            raise InvalidInput("Option not allowed")
        await self.solakon.select_option(key, option)

    async def async_force(self, action: str, watts: Any = None, minutes: Any = None) -> None:
        if action == "stop":
            await self.solakon.select_option("force_mode", "0")
            self.controller.pause(0)
        elif action in ("charge", "discharge"):
            max_w = MAX_CHARGE_W if action == "charge" else HARD_MAX_OUTPUT_W
            w = _checked(lambda: num(watts, 0, max_w, "Power"))
            mins = _checked(lambda: num(minutes, 1, 1092, "Duration"))
            self.controller.pause(mins * 60)
            # Lower the power before switching into a discharge mode, never the other way around.
            await self.solakon.set_number("force_power", w)
            await self.solakon.set_number("force_duration", mins)
            await self.solakon.select_option("force_mode", "3" if action == "charge" else "1")
        else:
            raise InvalidInput("Unknown action")
        self.schedule_push()

    async def async_update_settings(self, patch: dict) -> None:
        nxt = deep_merge(self.settings, patch)
        has_meter = bool(nxt["entities"].get("gridPower") or self.solakon.extra.get("gridPower"))
        _checked(lambda: validate(nxt, has_meter))
        rediscover = any(nxt.get(k) != self.settings.get(k) for k in ("entities", "devices", "overrides"))
        self.settings = nxt
        await self._store.async_save(nxt)
        if rediscover:
            self.solakon.async_discover()
        await self.controller.kick()
        self.schedule_push()

    @callback
    def async_rediscover(self) -> None:
        self.solakon.async_discover()


def get_hub(hass: HomeAssistant) -> Hub | None:
    return hass.data.get(DOMAIN, {}).get("hub")

