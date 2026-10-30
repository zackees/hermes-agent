"""Consent-gated sudo: announce agent requests to the approver's chat.

The agent records what it wants root for with ``hermes_consent_agent.py request``, which writes
``~/.hermes/consent/<id>.json``. Nothing pushes that file anywhere, so this watcher is the bridge:
every ``interval`` it lists requests without a decision and sends each one to the configured
approver as a two-button card (``TelegramAdapter.send_consent_approval``). The tap is recorded by
the platform callback (``gateway.consent_approvals.record_decision``), never here — this module
only reads and sends.

Profiles: the consent directory is per-host (``Path.home()/.hermes/consent``), not per
``HERMES_HOME``, because the root helper reads that one path. One scan per gateway process is
therefore correct even under multiplexing.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Optional

logger = logging.getLogger("gateway.consent")

INITIAL_DELAY_S = 5.0
POLL_SECONDS = 10.0


class GatewayConsentMixin:
    """Pending consent-request announcer (supervised watcher, see ``run_startup``)."""

    def _consent_adapter(self) -> Optional[Any]:
        """The Telegram adapter this gateway sends the approver's card through, if connected."""
        adapters = getattr(self, "adapters", None) or {}
        for platform, adapter in adapters.items():
            if getattr(platform, "value", platform) == "telegram":
                return adapter
        return None

    async def _consent_announce_pending(self) -> None:
        """Send a card for each request announced successfully; failed sends retry next tick."""
        from gateway import consent_approvals

        approver = consent_approvals.configured_approver()
        if not approver:
            return
        adapter = self._consent_adapter()
        if adapter is None:
            return
        announced = self.__dict__.setdefault("_consent_announced", set())
        for request in consent_approvals.pending_requests():
            request_id = str(request.get("id") or "")
            if not request_id or request_id in announced:
                continue
            result = await adapter.send_consent_approval(
                chat_id=approver, request_id=request_id,
                command=" ".join(str(arg) for arg in request.get("argv") or []),
                reason=str(request.get("reason") or ""))
            if getattr(result, "success", False):
                announced.add(request_id)
                logger.info("consent request %s announced to approver %s", request_id, approver)
            else:
                logger.warning(
                    "consent request %s: card send failed (%s); retrying next tick",
                    request_id, getattr(result, "error", "unknown"))

    async def _consent_watcher(self, interval: float = POLL_SECONDS) -> None:
        """Watch ``~/.hermes/consent`` for requests the human has not been shown yet."""
        await asyncio.sleep(INITIAL_DELAY_S)
        while getattr(self, "_running", True):
            try:
                await self._consent_announce_pending()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # a bad request file must never kill the watcher
                logger.debug("consent watcher tick failed: %s", exc)
            await asyncio.sleep(interval)
