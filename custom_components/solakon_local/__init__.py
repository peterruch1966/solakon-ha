"""Solakon Local: cloud-free Solakon ONE app as a Home Assistant sidebar panel, with local output control."""

from __future__ import annotations

from pathlib import Path

from homeassistant.components import frontend, panel_custom
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.start import async_at_started
from homeassistant.helpers.typing import ConfigType

from . import websocket
from .const import CONF_DEVICE_ID, DOMAIN, PANEL_ELEMENT, PANEL_URL_PATH, STATIC_URL, VERSION
from .hub import Hub

CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    hass.data.setdefault(DOMAIN, {"hub": None, "listeners": set(), "static": False})
    websocket.async_register(hass)
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    data = hass.data[DOMAIN]
    if not data["static"]:
        # Static paths cannot be removed again, so they are registered once per HA run.
        await hass.http.async_register_static_paths(
            [StaticPathConfig(STATIC_URL, str(Path(__file__).parent / "frontend"), False)]
        )
        data["static"] = True

    device_id = entry.options.get(CONF_DEVICE_ID, entry.data.get(CONF_DEVICE_ID)) or ""
    hub = Hub(hass, device_id, data["listeners"])
    await hub.async_load()
    data["hub"] = hub

    # Sensor units and states are only complete once all integrations have started.
    @callback
    def _started(_hass: HomeAssistant) -> None:
        hub.async_rediscover()

    entry.async_on_unload(async_at_started(hass, _started))
    entry.async_create_background_task(hass, hub.controller.run_forever(), f"{DOMAIN} controller")
    entry.async_on_unload(entry.add_update_listener(_async_reload))

    await panel_custom.async_register_panel(
        hass,
        webcomponent_name=PANEL_ELEMENT,
        frontend_url_path=PANEL_URL_PATH,
        module_url=f"{STATIC_URL}/solakon-panel.js?v={VERSION}",
        sidebar_title="Solakon",
        sidebar_icon="mdi:home-battery",
        require_admin=True,
        config={},
    )
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    frontend.async_remove_panel(hass, PANEL_URL_PATH)
    data = hass.data[DOMAIN]
    if hub := data["hub"]:
        hub.async_shutdown()
        data["hub"] = None
    return True


async def _async_reload(hass: HomeAssistant, entry: ConfigEntry) -> None:
    await hass.config_entries.async_reload(entry.entry_id)
