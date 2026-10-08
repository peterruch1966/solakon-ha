"""WebSocket commands used by the panel. History and statistics are read by the panel directly from HA."""

from __future__ import annotations

from typing import Any

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback

from .const import DOMAIN
from .hub import Hub, get_hub


@callback
def async_register(hass: HomeAssistant) -> None:
    for handler in (ws_subscribe, ws_device_sensors, ws_set_number, ws_select_option, ws_force,
                    ws_update_settings, ws_rediscover):
        websocket_api.async_register_command(hass, handler)


def _hub_or_error(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> Hub | None:
    hub = get_hub(hass)
    if hub is None:
        connection.send_error(msg["id"], "not_loaded", "Solakon Local is not set up or not loaded.")
    return hub


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/subscribe"})
@websocket_api.require_admin
@callback
def ws_subscribe(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    """Live state: a full snapshot now and after every change of a watched entity."""
    hub = _hub_or_error(hass, connection, msg)
    if hub is None:
        return
    listeners: set = hass.data[DOMAIN]["listeners"]

    @callback
    def forward(state: dict) -> None:
        connection.send_message(websocket_api.event_message(msg["id"], state))

    listeners.add(forward)
    connection.subscriptions[msg["id"]] = lambda: listeners.discard(forward)
    connection.send_result(msg["id"])
    forward(hub.state())


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/device_sensors"})
@websocket_api.require_admin
@callback
def ws_device_sensors(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    if hub := _hub_or_error(hass, connection, msg):
        connection.send_result(msg["id"], hub.device_sensors())


@websocket_api.websocket_command({
    vol.Required("type"): f"{DOMAIN}/set_number",
    vol.Required("key"): str,
    vol.Required("value"): vol.Coerce(float),
})
@websocket_api.require_admin
@websocket_api.async_response
async def ws_set_number(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    if hub := _hub_or_error(hass, connection, msg):
        await hub.async_set_number(msg["key"], msg["value"])
        connection.send_result(msg["id"])


@websocket_api.websocket_command({
    vol.Required("type"): f"{DOMAIN}/select_option",
    vol.Required("key"): str,
    vol.Required("option"): vol.Coerce(str),
})
@websocket_api.require_admin
@websocket_api.async_response
async def ws_select_option(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    if hub := _hub_or_error(hass, connection, msg):
        await hub.async_select_option(msg["key"], msg["option"])
        connection.send_result(msg["id"])


@websocket_api.websocket_command({
    vol.Required("type"): f"{DOMAIN}/force",
    vol.Required("action"): vol.In(["charge", "discharge", "stop"]),
    vol.Optional("watts"): vol.Coerce(float),
    vol.Optional("minutes"): vol.Coerce(float),
})
@websocket_api.require_admin
@websocket_api.async_response
async def ws_force(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    if hub := _hub_or_error(hass, connection, msg):
        await hub.async_force(msg["action"], msg.get("watts"), msg.get("minutes"))
        connection.send_result(msg["id"])


@websocket_api.websocket_command({
    vol.Required("type"): f"{DOMAIN}/update_settings",
    vol.Required("settings"): dict,
})
@websocket_api.require_admin
@websocket_api.async_response
async def ws_update_settings(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    if hub := _hub_or_error(hass, connection, msg):
        await hub.async_update_settings(msg["settings"])
        connection.send_result(msg["id"], {"settings": hub.settings})


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/rediscover"})
@websocket_api.require_admin
@callback
def ws_rediscover(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    if hub := _hub_or_error(hass, connection, msg):
        hub.async_rediscover()
        connection.send_result(msg["id"])
