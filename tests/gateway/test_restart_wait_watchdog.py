"""The restart deadline must cover the wait before stop(), including a failed wait task."""
import asyncio
from unittest.mock import AsyncMock

import pytest

import gateway.run_shutdown as shutdown
from gateway.restart import GATEWAY_SERVICE_RESTART_EXIT_CODE
from tests.gateway.restart_test_helpers import make_restart_runner


@pytest.mark.asyncio
@pytest.mark.parametrize("supervised_child", [False, True])
async def test_supervised_restart_arms_before_wait_and_disarms_after_stop(monkeypatch, supervised_child):
    monkeypatch.delenv("PYTEST_CURRENT_TEST", raising=False)
    monkeypatch.setenv("HERMES_SUPERVISED_CHILD", "1" if supervised_child else "0")
    armed = []
    monkeypatch.setattr(shutdown, "arm_shutdown_watchdog", lambda delay, **kw: armed.append((delay, kw)))
    monkeypatch.setattr(shutdown, "_effective_watchdog_leash", lambda runner: 60.0)
    runner, _ = make_restart_runner()
    runner._restart_after_turn_timeout = 30.0
    wait_started, release_wait = asyncio.Event(), asyncio.Event()

    async def wait():
        wait_started.set()
        await release_wait.wait()

    runner._await_active_work_before_restart = wait
    runner.stop = AsyncMock()
    assert runner.request_restart(via_service=not supervised_child)
    assert len(armed) == 1  # synchronous, before the restart task can run
    delay, options = armed[0]
    assert delay == 90.0
    assert options["exit_code"] == GATEWAY_SERVICE_RESTART_EXIT_CODE
    await wait_started.wait()
    assert not options["done_event"].is_set()
    release_wait.set()
    await runner._restart_task
    runner.stop.assert_awaited_once()
    assert options["done_event"].is_set()


@pytest.mark.asyncio
async def test_failed_restart_keeps_supervisor_deadline_armed(monkeypatch):
    monkeypatch.delenv("PYTEST_CURRENT_TEST", raising=False)
    armed = []
    monkeypatch.setattr(shutdown, "arm_shutdown_watchdog", lambda delay, **kw: armed.append(kw))
    runner, _ = make_restart_runner()
    runner._await_active_work_before_restart = AsyncMock(side_effect=RuntimeError("wait failed"))
    runner.stop = AsyncMock()
    runner.request_restart(via_service=True)
    with pytest.raises(RuntimeError, match="wait failed"):
        await runner._restart_task
    assert not armed[0]["done_event"].is_set()
    runner.stop.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("wait_timeout,stop_leash", [(float("inf"), 60.0), (30.0, float("nan"))])
async def test_nonfinite_configuration_cannot_disable_restart_deadline(monkeypatch, wait_timeout, stop_leash):
    import math
    monkeypatch.delenv("PYTEST_CURRENT_TEST", raising=False)
    armed = []
    monkeypatch.setattr(shutdown, "arm_shutdown_watchdog", lambda delay, **kw: armed.append(delay))
    monkeypatch.setattr(shutdown, "_effective_watchdog_leash", lambda runner: stop_leash)
    runner, _ = make_restart_runner()
    runner._restart_after_turn_timeout = wait_timeout
    runner._await_active_work_before_restart = AsyncMock()
    runner.stop = AsyncMock()
    runner.request_restart(via_service=True)
    assert math.isfinite(armed[0]) and armed[0] > 0
    await runner._restart_task
