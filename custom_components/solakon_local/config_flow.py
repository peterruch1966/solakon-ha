"""Config flow: one instance; optionally pin the Solakon ONE device when there is more than one."""

from __future__ import annotations

from typing import Any

import voluptuous as vol

from homeassistant.config_entries import ConfigEntry, ConfigFlow, ConfigFlowResult, OptionsFlow
from homeassistant.core import callback
from homeassistant.helpers import selector

from .const import CONF_DEVICE_ID, DOMAIN, SOLAKON_PLATFORM


def _schema(default: str | None) -> vol.Schema:
    key = vol.Optional(CONF_DEVICE_ID, description={"suggested_value": default}) if default else vol.Optional(CONF_DEVICE_ID)
    return vol.Schema({key: selector.DeviceSelector(selector.DeviceSelectorConfig(integration=SOLAKON_PLATFORM))})


class SolakonLocalConfigFlow(ConfigFlow, domain=DOMAIN):
    VERSION = 1

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        await self.async_set_unique_id(DOMAIN)
        self._abort_if_unique_id_configured()
        if user_input is not None:
            return self.async_create_entry(title="Solakon Local", data={CONF_DEVICE_ID: user_input.get(CONF_DEVICE_ID, "")})
        return self.async_show_form(step_id="user", data_schema=_schema(None))

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: ConfigEntry) -> OptionsFlow:
        return SolakonLocalOptionsFlow()


class SolakonLocalOptionsFlow(OptionsFlow):
    async def async_step_init(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        if user_input is not None:
            return self.async_create_entry(data={CONF_DEVICE_ID: user_input.get(CONF_DEVICE_ID, "")})
        current = self.config_entry.options.get(CONF_DEVICE_ID, self.config_entry.data.get(CONF_DEVICE_ID))
        return self.async_show_form(step_id="init", data_schema=_schema(current))
