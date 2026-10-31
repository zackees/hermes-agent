"""Partial read -> write_file refused -> same partial re-read must not loop forever.

The refusal has to name the exact lines this task has not seen, so one follow-up
read always satisfies the full-view precondition; an unread file stays refused.
"""

import json

import pytest

from tools import file_state
from tools.file_tools import read_file_tool, write_file_tool
from tools.file_tools_read_tracking import _read_tracker, notify_other_tool_call


@pytest.fixture(autouse=True)
def _clean_state():
    _read_tracker.clear()
    file_state.get_registry().clear()
    yield
    _read_tracker.clear()
    file_state.get_registry().clear()


@pytest.fixture
def tasks_md(tmp_path):
    p = tmp_path / "TASKS.md"
    p.write_text("".join(f"task {i}\n" for i in range(1, 69)))
    return p


def _write(path, task_id):
    notify_other_tool_call(task_id)  # the dispatcher does this between tool calls
    return json.loads(write_file_tool(str(path), "new\n", task_id=task_id))


def test_naive_retry_loop_is_refused_every_time(tasks_md):
    """The observed loop: a 14-line window, refusal, the same window again."""
    for _ in range(3):
        read_file_tool(str(tasks_md), offset=20, limit=14, task_id="t")
        out = _write(tasks_md, "t")
        assert out.get("stale_write_blocked") is True
    assert tasks_md.read_text().startswith("task 1\n")


def test_refusal_names_missing_ranges_and_one_retry_succeeds(tasks_md):
    read_file_tool(str(tasks_md), offset=20, limit=14, task_id="t")
    out = _write(tasks_md, "t")
    assert out["stale_write_blocked"] is True
    assert out["unread_ranges"] == [[1, 19], [34, 68]]
    assert "read_file with no offset/limit" in out["error"]
    # Follow the instruction literally: one full read, then the write goes through.
    read_file_tool(str(tasks_md), task_id="t")
    out = _write(tasks_md, "t")
    assert "error" not in out, out
    assert tasks_md.read_text() == "new\n"


def test_reading_exactly_the_named_ranges_also_satisfies_it(tasks_md):
    read_file_tool(str(tasks_md), offset=20, limit=14, task_id="t")
    out = _write(tasks_md, "t")
    for start, end in out["unread_ranges"]:
        notify_other_tool_call("t")
        read_file_tool(str(tasks_md), offset=start, limit=end - start + 1, task_id="t")
    out = _write(tasks_md, "t")
    assert "error" not in out, out


def test_never_read_file_is_still_refused(tasks_md):
    out = _write(tasks_md, "t")
    assert out["stale_write_blocked"] is True
    assert out["unread_ranges"] == [[1, 68]]
    assert tasks_md.read_text().startswith("task 1\n")


def test_partial_read_response_states_write_precondition(tasks_md):
    out = json.loads(read_file_tool(str(tasks_md), offset=20, limit=14, task_id="t"))
    assert "write_file" in out["_write_precondition"]
    full = json.loads(read_file_tool(str(tasks_md), task_id="t"))
    assert "_write_precondition" not in full
