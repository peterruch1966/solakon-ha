import unittest
from datetime import datetime

from solakon_local.controller import Controller, active_schedule_entry, zero_feed_in_target
from solakon_local.settings import DEFAULT_SETTINGS, deep_merge


def at(day: int, hh: int, mm: int = 0) -> datetime:
    """2026-10-04 is a Sunday (day 0, as stored in the schedule)."""
    return datetime(2026, 10, 4 + day, hh, mm)


class ScheduleTest(unittest.TestCase):
    def test_same_day_window(self):
        s = [{"start": "08:00", "end": "12:00", "mode": "constant", "watts": 100}]
        self.assertIsNotNone(active_schedule_entry(s, at(1, 9)))
        self.assertIsNone(active_schedule_entry(s, at(1, 12)))
        self.assertIsNone(active_schedule_entry(s, at(1, 7, 59)))

    def test_overnight_window_belongs_to_the_start_day(self):
        s = [{"start": "22:00", "end": "06:00", "days": [5], "mode": "constant", "watts": 100}]  # Friday night
        self.assertIsNotNone(active_schedule_entry(s, at(5, 23)))
        self.assertIsNotNone(active_schedule_entry(s, at(6, 5)))  # Saturday early morning
        self.assertIsNone(active_schedule_entry(s, at(6, 23)))
        self.assertIsNone(active_schedule_entry(s, at(5, 5)))

    def test_disabled_entries_are_skipped_first_match_wins(self):
        s = [
            {"enabled": False, "start": "00:00", "end": "23:59", "mode": "off"},
            {"start": "00:00", "end": "23:59", "mode": "zero"},
            {"start": "00:00", "end": "23:59", "mode": "constant"},
        ]
        self.assertEqual(active_schedule_entry(s, at(2, 10))["mode"], "zero")


CFG = {"targetGridW": 10, "smoothing": 1}


class ZeroFeedInTest(unittest.TestCase):
    def test_raises_output_when_importing(self):
        self.assertEqual(zero_feed_in_target(grid_w=210, output_w=100, last_target_w=100, cfg=CFG, max_w=800), 300)

    def test_lowers_output_when_exporting_and_never_goes_negative(self):
        self.assertEqual(zero_feed_in_target(grid_w=-90, output_w=300, last_target_w=300, cfg=CFG, max_w=800), 200)
        self.assertEqual(zero_feed_in_target(grid_w=-900, output_w=300, last_target_w=300, cfg=CFG, max_w=800), 0)

    def test_is_capped_at_max_output(self):
        self.assertEqual(zero_feed_in_target(grid_w=2000, output_w=600, last_target_w=600, cfg=CFG, max_w=800), 800)

    def test_applies_smoothing_and_falls_back_to_last_target(self):
        cfg = {**CFG, "smoothing": 0.5}
        self.assertEqual(zero_feed_in_target(grid_w=110, output_w=None, last_target_w=200, cfg=cfg, max_w=800), 250)


class FakeSolakon:
    """Stands in for solakon.Solakon: values by key and a log of the commands sent."""

    def __init__(self, values: dict, grid_w: float | None = None):
        self.values = dict(values)
        self.grid_w = grid_w
        self.ready = True
        self.calls: list[str] = []

    def get(self, key):
        return self.values.get(key)

    def grid_power(self):
        return self.grid_w

    async def set_number(self, key, value):
        self.calls.append(f"{key}={value}")
        self.values[key] = value

    async def select_option(self, key, option):
        self.calls.append(f"{key}={option}")
        self.values[key] = int(option)


class ControllerTest(unittest.IsolatedAsyncioTestCase):
    def make(self, control: dict, **solakon):
        settings = deep_merge(DEFAULT_SETTINGS, {"control": control})
        s = FakeSolakon({"remote_control_mode": 0, "active_power": 280}, **solakon)
        return Controller(s, lambda: settings, now=lambda: at(1, 12)), s

    async def test_zero_feed_in_writes_setpoint_before_enabling_the_mode(self):
        c, s = self.make({"mode": "zero", "zero": {"smoothing": 1, "targetGridW": 10}}, grid_w=150)
        await c.tick()
        self.assertEqual(c.status["mode"], "zero")
        self.assertEqual(c.status["targetW"], 420)  # 280 + (150 - 10)
        self.assertLess(s.calls.index("remote_active_power=420"), s.calls.index("remote_control_mode=1"))
        self.assertIn("remote_timeout_set=120", s.calls)

    async def test_zero_feed_in_without_meter_sends_zero(self):
        c, s = self.make({"mode": "zero"}, grid_w=None)
        await c.tick()
        self.assertEqual(c.status["targetW"], 0)
        self.assertIsNotNone(c.status["error"])
        self.assertIn("remote_active_power=0", s.calls)

    async def test_constant_is_capped_at_max_output(self):
        c, s = self.make({"mode": "constant", "constantW": 700, "maxOutputW": 500})
        await c.tick()
        self.assertEqual(c.status["targetW"], 500)

    async def test_small_changes_within_the_deadband_are_not_written(self):
        c, s = self.make({"mode": "zero", "zero": {"smoothing": 1, "targetGridW": 10, "deadbandW": 15}}, grid_w=150)
        await c.tick()
        s.calls.clear()
        s.values["active_power"] = 420
        s.grid_w = 20  # target 430, 10 W above the last setpoint
        await c.tick()
        self.assertNotIn("remote_active_power=430", s.calls)

    async def test_switching_to_off_releases_remote_control(self):
        settings = deep_merge(DEFAULT_SETTINGS, {"control": {"mode": "constant", "constantW": 100}})
        s = FakeSolakon({"remote_control_mode": 0})
        c = Controller(s, lambda: settings, now=lambda: at(1, 12))
        await c.tick()
        self.assertEqual(s.values["remote_control_mode"], 1)
        settings["control"]["mode"] = "off"
        await c.kick()
        self.assertEqual(s.values["remote_control_mode"], 0)
        self.assertFalse(c.managing)

    async def test_schedule_overrides_the_base_mode(self):
        c, s = self.make({"mode": "off", "schedule": [{"start": "11:00", "end": "13:00", "mode": "constant", "watts": 150}]})
        await c.tick()
        self.assertEqual(c.status["source"], "schedule")
        self.assertEqual(c.status["targetW"], 150)

    async def test_pause_leaves_the_device_alone(self):
        c, s = self.make({"mode": "constant", "constantW": 100})
        c.pause(600)
        await c.tick()
        self.assertEqual(c.status["mode"], "paused")
        self.assertEqual(s.calls, [])


if __name__ == "__main__":
    unittest.main()
