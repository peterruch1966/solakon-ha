"""Constants of the Solakon Local integration (no Home Assistant imports, so the logic stays testable)."""

DOMAIN = "solakon_local"
VERSION = "2.0.0"

# Entities of the official Solakon ONE integration.
SOLAKON_PLATFORM = "solakon_one"

CONF_DEVICE_ID = "device_id"

PANEL_URL_PATH = "solakon"
PANEL_ELEMENT = "solakon-panel"
STATIC_URL = "/solakon_local_static"

HARD_MAX_OUTPUT_W = 800  # the device must never be asked to discharge more
MAX_CHARGE_W = 1200

# Writable device settings exposed in the panel, with their allowed ranges.
NUMBER_LIMITS = {
    "minimum_soc": (10, 100),
    "maximum_soc": (0, 100),
    "minimum_soc_ongrid": (10, 100),
    "battery_max_charge_current": (0, 40),
    "battery_max_discharge_current": (0, 40),
    "grid_export_power_limit": (0, HARD_MAX_OUTPUT_W),
}
SELECT_OPTIONS = {
    "eps_output": ("0", "2", "3"),
}
