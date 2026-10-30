"""Gateway half of consent-gated sudo (the ``hermes-sudo-consent`` skill).

The agent writes ``~/.hermes/consent/<id>.json`` with ``hermes_consent_agent.py request``; the root
helper (``hermes-consent-exec``) refuses to run that argv until a matching ``<id>.approved`` exists,
and then re-checks the approver id, the TTL, the single-use claim and the argv hash itself.

Only the gateway may write ``<id>.approved``: this module is the single writer, and its only caller
is the platform button-tap handler (``TelegramAdapter._handle_consent_callback``), which passes the
*real* ``update.update_id`` / ``query.message.message_id`` of the ``callback_query`` Telegram
delivered. That is what makes the record evidence of a human tap instead of an agent assertion: no
tool, no agent-side command and no CLI entry point in this repo reaches :func:`record_decision`.

Layout, hashing and the payload keys mirror ``scripts/hermes_consent_agent.py`` (approve) so the
root helper sees one format. The directory is the same one the agent CLI uses (``~/.hermes/consent``)
— not the profile ``HERMES_HOME`` — because that is where the helper looks.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import secrets
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Optional, Sequence

logger = logging.getLogger("gateway.consent")

# Same shape the agent CLI (check_id) and the root helper enforce.
CONSENT_ID_RE = re.compile(r"^[0-9a-f]{32}$")
DECISIONS = ("approve", "deny")
_APPROVED_SUFFIX = ".approved"
_DENIED_SUFFIX = ".denied"
REQUEST_SUFFIX = ".json"


class ConsentRefused(Exception):
    """The tap cannot become an approval; ``str(exc)`` is the machine-readable reason."""


def consent_dir() -> Path:
    """Directory shared with the agent CLI and the root helper."""
    override = os.environ.get("HERMES_CONSENT_DIR", "").strip()
    return Path(override) if override else Path.home() / ".hermes" / "consent"


def config_path() -> Path:
    """The root-side config naming the one Telegram user allowed to approve."""
    override = os.environ.get("HERMES_CONSENT_CONFIG", "").strip()
    return Path(override) if override else Path("/etc/hermes-consent/config.json")


def argv_digest(argv: Sequence[str]) -> str:
    """Must match ``hermes_consent_exec.argv_digest`` byte for byte."""
    return hashlib.sha256(b"\0".join(arg.encode("utf-8") for arg in argv)).hexdigest()


def now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def _read_json(path: Path) -> Optional[dict[str, Any]]:
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return loaded if isinstance(loaded, dict) else None


def configured_approver() -> Optional[str]:
    """Telegram user id string from the root config, or None when absent/unreadable."""
    config = _read_json(config_path())
    raw = (config or {}).get("telegram_user_id")
    if isinstance(raw, bool) or not isinstance(raw, (int, str)):
        return None
    token = str(raw).strip()
    return token or None


def is_authorized_approver(user_id: Any) -> bool:
    """True only for the configured approver; fail closed when no config exists."""
    approver = configured_approver()
    claimant = str(user_id if user_id is not None else "").strip()
    return bool(approver) and claimant == approver


def load_request(request_id: str) -> Optional[dict[str, Any]]:
    """The agent's request document, or None when missing/unreadable/not an id."""
    if not CONSENT_ID_RE.match(str(request_id or "")):
        return None
    return _read_json(consent_dir() / f"{request_id}{REQUEST_SUFFIX}")


def decision_path(request_id: str, decision: str) -> Path:
    suffix = _APPROVED_SUFFIX if decision == "approve" else _DENIED_SUFFIX
    return consent_dir() / f"{request_id}{suffix}"


def has_decision(request_id: str) -> bool:
    return any(decision_path(request_id, d).exists() for d in DECISIONS)


def pending_requests() -> list[dict[str, Any]]:
    """Requests with no decision yet, oldest first; a malformed one is skipped, not fatal."""
    directory = consent_dir()
    try:
        paths = sorted(directory.glob(f"*{REQUEST_SUFFIX}"))
    except OSError:
        return []
    pending = []
    for path in paths:
        request_id = path.stem
        if not CONSENT_ID_RE.match(request_id) or has_decision(request_id):
            continue
        request = _read_json(path)
        if request is None or request.get("id") != request_id:
            continue
        pending.append(request)
    return pending


def _as_id(value: Any, label: str) -> int:
    if isinstance(value, bool):
        raise ConsentRefused(f"bad_{label}_id")
    try:
        number = int(value)
    except (TypeError, ValueError):
        raise ConsentRefused(f"bad_{label}_id") from None
    if number < 0:
        raise ConsentRefused(f"bad_{label}_id")
    return number


def _create_exclusive(destination: Path, payload: dict[str, Any]) -> Optional[Path]:
    """Write ``payload`` to ``destination`` only if it does not exist yet.

    ``os.link`` is the atomic primitive: it fails with EEXIST instead of replacing, so two taps
    racing on the same message can never mint two decisions and a re-tap cannot overwrite the
    original approver/update ids.
    """
    directory = destination.parent
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = directory / f".{destination.name}.{os.getpid()}.{secrets.token_hex(4)}.tmp"
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(json.dumps(payload, indent=2, sort_keys=True) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        try:
            os.link(temporary, destination)
        except FileExistsError:
            return None
    finally:
        try:
            temporary.unlink()
        except OSError:
            pass
    return destination


def record_decision(
    action: str, request_id: str, *, approver_id: Any, update_id: Any, message_id: Any,
    decided_at: Optional[str] = None,
) -> Optional[Path]:
    """Record one human tap as ``<id>.approved`` / ``<id>.denied``.

    Returns the path, or None when a decision already exists (first tap wins). Raises
    :class:`ConsentRefused` for anything that is not a well-formed tap on an intact request.
    """
    if action not in DECISIONS:
        raise ConsentRefused("bad_action")
    if not CONSENT_ID_RE.match(str(request_id or "")):
        raise ConsentRefused("bad_id")
    approver = _as_id(approver_id, "approver")
    update = _as_id(update_id, "update")
    message = _as_id(message_id, "message")
    request = load_request(request_id)
    if request is None:
        raise ConsentRefused("no_request")
    argv = request.get("argv")
    if not isinstance(argv, list) or not argv or not all(isinstance(arg, str) for arg in argv):
        raise ConsentRefused("request_tampered")
    digest = argv_digest(argv)
    if request.get("argv_sha256") != digest:
        # The request changed after it was written: the approving human would be approving an
        # argv the agent never showed them.
        raise ConsentRefused("request_tampered")
    if has_decision(request_id):
        return None

    timestamp = decided_at or now_iso()
    payload: dict[str, Any] = {
        "id": request_id,
        "approver_telegram_user_id": approver,
        "update_id": update,
        "message_id": message,
        "argv_sha256": digest,
        "approved_at" if action == "approve" else "denied_at": timestamp,
    }
    path = _create_exclusive(decision_path(request_id, action), payload)
    if path is None:
        return None
    # One audit line per tap; the root helper appends its own allowed/denied line when run.
    logger.info(
        "consent %s id=%s approver=%s update=%s message=%s", action, request_id, approver, update, message,
    )
    return path
