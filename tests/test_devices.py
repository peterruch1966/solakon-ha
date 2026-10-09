import unittest

from solakon_local.devices import find_device, pick_inverter, pick_heatpump, pick_meter, pick_wallbox, sensors_of


def energy(unit, name):
    return {"unit_of_measurement": unit, "device_class": "energy", "state_class": "total_increasing", "friendly_name": name}


def power(name, unit="W"):
    return {"unit_of_measurement": unit, "device_class": "power", "state_class": "measurement", "friendly_name": name}


# A Hoymiles micro inverter (OpenDTU style), a grid meter (Shelly style), a KEBA wallbox and a Vitocal heat pump.
FIXTURE = {
    "dev-hoymiles": ("Solaranlage Hoymiles", {
        "sensor.solaranlage_hoymiles_power": ("420", power("Solaranlage Hoymiles Power")),
        "sensor.solaranlage_hoymiles_power_dc": ("441", power("Solaranlage Hoymiles Power DC")),
        "sensor.solaranlage_hoymiles_yieldday": ("1830", energy("Wh", "Solaranlage Hoymiles YieldDay")),
        "sensor.solaranlage_hoymiles_yieldtotal": ("812.5", energy("kWh", "Solaranlage Hoymiles YieldTotal")),
    }),
    "dev-meter": ("PowerMeter", {
        "sensor.powermeter_phase_a_power": ("-40", power("PowerMeter Phase A power")),
        "sensor.powermeter_power": ("-120", power("PowerMeter Power")),
        "sensor.powermeter_phase_a_energy": ("1500", energy("kWh", "PowerMeter Phase A energy")),
        "sensor.powermeter_total_energy": ("4321", energy("kWh", "PowerMeter Total energy")),
        "sensor.powermeter_total_energy_returned": ("987.6", energy("kWh", "PowerMeter Total energy returned")),
    }),
    # Power in kW, plus current and energy sensors that must not be picked.
    "dev-keba": ("KEBA P30", {
        "sensor.keba_p30_max_current": ("16", {"unit_of_measurement": "A", "friendly_name": "KEBA P30 Max current"}),
        "sensor.keba_p30_charging_power": ("3.7", power("KEBA P30 Charging power", "kW")),
        "sensor.keba_p30_total_energy": ("1234.5", energy("kWh", "KEBA P30 Total energy")),
    }),
    # Device name differs from the entity ID prefix; thermal output must not be picked.
    "dev-vitocal": ("Vitocal 250-A", {
        "sensor.e3_vitocal_16_heating_thermal_power": ("6.1", power("Vitocal Heating thermal power", "kW")),
        "sensor.e3_vitocal_16_power_consumption": ("1450", power("Vitocal Power consumption")),
        "sensor.e3_vitocal_16_power_consumption_today": ("8.2", energy("kWh", "Vitocal Power consumption today")),
    }),
}

DEVICES = [{"id": dev_id, "name": name, "name_by_user": None} for dev_id, (name, _) in FIXTURE.items()]
ENTRIES = [
    {"entity_id": eid, "device_id": dev_id, "disabled_by": None, "name": None, "original_name": None}
    for dev_id, (_, sensors) in FIXTURE.items() for eid in sensors
]
STATES = {eid: {"state": s, "attributes": a} for _, sensors in FIXTURE.values() for eid, (s, a) in sensors.items()}


def sensors(dev_id):
    return sensors_of(ENTRIES, STATES, dev_id)


class FindDeviceTest(unittest.TestCase):
    def test_exact_name_and_substring(self):
        self.assertEqual(find_device(DEVICES, "PowerMeter")["id"], "dev-meter")
        self.assertEqual(find_device(DEVICES, "solaranlage hoymiles")["id"], "dev-hoymiles")
        self.assertEqual(find_device(DEVICES, "keba")["id"], "dev-keba")

    def test_falls_back_to_entity_id(self):
        self.assertIsNone(find_device(DEVICES, "e3_vitocal_16"))
        self.assertEqual(find_device(DEVICES, "e3_vitocal_16", ENTRIES)["id"], "dev-vitocal")

    def test_user_name_wins_and_empty_name_finds_nothing(self):
        devices = DEVICES + [{"id": "dev-renamed", "name": "Shelly Pro 3EM", "name_by_user": "PowerMeter"}]
        devices[1] = {**devices[1], "name": "PowerMeter 2"}
        self.assertEqual(find_device(devices, "PowerMeter")["id"], "dev-renamed")
        self.assertIsNone(find_device(DEVICES, ""))
        self.assertIsNone(find_device(DEVICES, "Not there"))


class PickSensorsTest(unittest.TestCase):
    def test_sensors_of_skips_other_units(self):
        ids = [s["entityId"] for s in sensors("dev-keba")]
        self.assertNotIn("sensor.keba_p30_max_current", ids)

    def test_inverter(self):
        self.assertEqual(pick_inverter(sensors("dev-hoymiles")), {
            "pvPower": "sensor.solaranlage_hoymiles_power",
            "pvEnergy": "sensor.solaranlage_hoymiles_yieldtotal",
        })

    def test_meter(self):
        self.assertEqual(pick_meter(sensors("dev-meter")), {
            "gridPower": "sensor.powermeter_power",
            "gridImportEnergy": "sensor.powermeter_total_energy",
            "gridExportEnergy": "sensor.powermeter_total_energy_returned",
        })

    def test_wallbox(self):
        self.assertEqual(pick_wallbox(sensors("dev-keba")), {"wallboxPower": "sensor.keba_p30_charging_power"})

    def test_heatpump(self):
        self.assertEqual(pick_heatpump(sensors("dev-vitocal")), {"heatpumpPower": "sensor.e3_vitocal_16_power_consumption"})

    def test_nothing_to_pick(self):
        self.assertEqual(pick_meter([]), {"gridPower": "", "gridImportEnergy": "", "gridExportEnergy": ""})


if __name__ == "__main__":
    unittest.main()
