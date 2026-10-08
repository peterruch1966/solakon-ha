import unittest

from solakon_local.settings import DEFAULT_SETTINGS, SettingsError, deep_merge, num, validate


class DeepMergeTest(unittest.TestCase):
    def test_merges_dicts_and_replaces_lists(self):
        base = deep_merge(DEFAULT_SETTINGS, {"control": {"schedule": [{"start": "1:00"}]}})
        out = deep_merge(base, {"control": {"mode": "zero", "schedule": []}})
        self.assertEqual(out["control"]["mode"], "zero")
        self.assertEqual(out["control"]["schedule"], [])
        self.assertEqual(out["control"]["constantW"], DEFAULT_SETTINGS["control"]["constantW"])

    def test_does_not_modify_its_inputs(self):
        base = deep_merge(DEFAULT_SETTINGS, {})
        deep_merge(base, {"control": {"zero": {"intervalS": 9}}})
        self.assertEqual(base["control"]["zero"]["intervalS"], DEFAULT_SETTINGS["control"]["zero"]["intervalS"])


class NumTest(unittest.TestCase):
    def test_accepts_numbers_in_range(self):
        self.assertEqual(num("42", 0, 100, "x"), 42)
        self.assertEqual(num(0.5, 0, 1, "x"), 0.5)

    def test_rejects_out_of_range_and_non_numbers(self):
        for bad in (101, -1, "abc", None, True, float("nan"), float("inf")):
            with self.assertRaises(SettingsError, msg=repr(bad)):
                num(bad, 0, 100, "x")


class ValidateTest(unittest.TestCase):
    def settings(self, **control):
        return deep_merge(DEFAULT_SETTINGS, {"control": control})

    def test_defaults_are_valid(self):
        validate(self.settings(), has_grid_power=True)

    def test_max_output_is_capped_at_800_w(self):
        with self.assertRaises(SettingsError):
            validate(self.settings(maxOutputW=900), True)

    def test_constant_output_must_not_exceed_max_output(self):
        with self.assertRaises(SettingsError):
            validate(self.settings(maxOutputW=300, constantW=400), True)

    def test_zero_feed_in_needs_a_meter(self):
        with self.assertRaises(SettingsError):
            validate(self.settings(mode="zero"), has_grid_power=False)
        validate(self.settings(mode="zero"), has_grid_power=True)

    def test_schedule_entries_are_checked(self):
        with self.assertRaises(SettingsError):
            validate(self.settings(schedule=[{"start": "25", "end": "06:00", "mode": "constant"}]), True)
        with self.assertRaises(SettingsError):
            validate(self.settings(schedule=[{"start": "22:00", "end": "06:00", "mode": "boost"}]), True)
        s = self.settings(schedule=[{"start": "22:00", "end": "06:00", "mode": "off"}])
        validate(s, True)
        self.assertEqual(s["control"]["schedule"][0]["watts"], 0)


if __name__ == "__main__":
    unittest.main()
