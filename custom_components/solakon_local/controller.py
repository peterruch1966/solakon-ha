"""Local output control, replacing the cloud-based control of the Solakon app.

The device is driven through the remote control registers exposed by the solakon_one
integration: a remote control mode, an active power setpoint and a timeout. The timeout is
refreshed while the controller runs, so if Home Assistant (or this integration) stops, the
device falls back to its own behaviour after `timeoutS` seconds.

No Home Assistant imports: `solakon` is anything with get(), grid_power(), ready and the async
set_number() / select_option() commands, which keeps the control logic unit-testable.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Callable
from datetime import datetime, timezone
from typing import Any

from .const import HARD_MAX_OUTPUT_W

_LOGGER = logging.getLogger(__name__)


def _minutes(hhmm: Any) -> int:
    parts = (str(hhmm or "0:0").split(":") + ["0"])[:2]

    def n(x: str) -> int:
        try:
            return int(x)
        except ValueError:
            return 0

    return n(parts[0]) * 60 + n(parts[1])


def _js_weekday(d: datetime) -> int:
    """0 = Sunday … 6 = Saturday, as stored in the schedule."""
    return (d.weekday() + 1) % 7


def active_schedule_entry(schedule: list[dict] | None, now: datetime) -> dict | None:
    day = _js_weekday(now)
    t = now.hour * 60 + now.minute
    for e in schedule or []:
        if e.get("enabled") is False:
            continue
        start = _minutes(e.get("start"))
        end = _minutes(e.get("end"))
        days = e.get("days") or [0, 1, 2, 3, 4, 5, 6]
        if start <= end:
            if day in days and start <= t < end:
                return e
        # Window crosses midnight: the part after midnight belongs to the previous day's entry.
        elif (day in days and t >= start) or ((day + 6) % 7 in days and t < end):
            return e
    return None


def zero_feed_in_target(*, grid_w: float, output_w: Any, last_target_w: float, cfg: dict, max_w: float) -> int:
    base = output_w if isinstance(output_w, (int, float)) and not isinstance(output_w, bool) else last_target_w
    error = grid_w - cfg["targetGridW"]  # >0: importing more than wanted -> raise output
    nxt = base + error * cfg["smoothing"]
    return round(max(0, min(max_w, nxt)))


class Controller:
    def __init__(self, solakon, get_settings: Callable[[], dict], now: Callable[[], datetime] = datetime.now) -> None:
        self.solakon = solakon
        self.get_settings = get_settings
        self.now = now
        self._lock = asyncio.Lock()
        self.managing = False
        self.last_target_w = 0
        self.last_sent_w: int | None = None
        self.last_timeout_write = 0.0
        self.paused_until = 0.0
        self.status: dict[str, Any] = {"mode": "off", "source": "settings", "targetW": None, "error": None, "lastWrite": None}

    async def run_forever(self) -> None:
        await asyncio.sleep(2)
        while True:
            await self.tick()
            await asyncio.sleep(self.interval_s())

    def interval_s(self) -> float:
        c = self.get_settings()["control"]
        return max(2, float(c["zero"].get("intervalS") or 5))

    def effective_mode(self) -> tuple[str, float, str]:
        c = self.get_settings()["control"]
        entry = active_schedule_entry(c.get("schedule"), self.now())
        if entry:
            return entry.get("mode"), float(entry.get("watts") or 0), "schedule"
        return c["mode"], float(c.get("constantW") or 0), "settings"

    async def tick(self) -> None:
        if self._lock.locked() or not self.solakon.ready:
            return
        async with self._lock:
            try:
                await self._run()
            except Exception as err:  # noqa: BLE001 - keep the loop alive, show the error in the panel
                self.status["error"] = str(err)
                _LOGGER.error("Controller: %s", err)

    async def _run(self) -> None:
        c = self.get_settings()["control"]
        if time.time() < self.paused_until:
            # A manual force charge/discharge owns the remote control registers right now.
            until = datetime.fromtimestamp(self.paused_until, tz=timezone.utc).isoformat()
            self.status = {**self.status, "mode": "paused", "pausedUntil": until}
            self.managing = False
            return
        self.status.pop("pausedUntil", None)
        mode, watts, source = self.effective_mode()
        max_w = min(HARD_MAX_OUTPUT_W, float(c.get("maxOutputW") or HARD_MAX_OUTPUT_W))
        self.status["mode"] = mode
        self.status["source"] = source

        if mode == "off":
            if self.managing:
                await self.release()
            self.status["targetW"] = None
            self.status["error"] = None
            return

        if mode == "constant":
            target = round(max(0, min(max_w, watts)))
        elif mode == "zero":
            grid_w = self.solakon.grid_power()
            if grid_w is None:
                self.status["error"] = "No smart meter value – configure the grid power entity in settings."
                target = 0
            else:
                self.status["error"] = None
                target = zero_feed_in_target(
                    grid_w=grid_w,
                    output_w=self.solakon.get("active_power"),
                    last_target_w=self.last_target_w,
                    cfg=c["zero"],
                    max_w=max_w,
                )
        else:
            raise ValueError(f'Unknown control mode "{mode}"')

        self.last_target_w = target
        self.status["targetW"] = target
        await self._apply(target, c)

    async def _apply(self, target_w: int, c: dict) -> None:
        s = self.solakon
        deadband = float(c["zero"].get("deadbandW") or 0)
        mode_ok = str(s.get("remote_control_mode")) == str(c["remoteMode"])
        now = time.time()

        if (not mode_ok or self.last_sent_w is None or abs(target_w - self.last_sent_w) >= deadband
                or (target_w == 0 and self.last_sent_w != 0)):
            # Write the setpoint before enabling the mode so it never starts with a stale, higher value.
            await s.set_number("remote_active_power", target_w)
            self.last_sent_w = target_w
            self.status["lastWrite"] = datetime.now(timezone.utc).isoformat()
        if not mode_ok or now - self.last_timeout_write > c["timeoutS"] / 3:
            await s.set_number("remote_timeout_set", c["timeoutS"])
            self.last_timeout_write = now
        if not mode_ok:
            _LOGGER.info("Enabling remote control mode %s", c["remoteMode"])
            await s.select_option("remote_control_mode", c["remoteMode"])
        self.managing = True

    async def release(self) -> None:
        _LOGGER.info("Releasing remote control")
        await self.solakon.select_option("remote_control_mode", "0")
        self.managing = False
        self.last_sent_w = None
        self.last_timeout_write = 0.0

    def pause(self, seconds: float) -> None:
        self.paused_until = time.time() + seconds if seconds > 0 else 0.0
        self.last_sent_w = None
        self.last_timeout_write = 0.0

    async def kick(self) -> None:
        """Called when settings change so a new mode takes effect immediately."""
        self.last_sent_w = None
        await self.tick()
