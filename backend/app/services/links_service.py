"""
Links Service: Manages interview links with moderator tokens
"""

import hmac
import time
import base64
import hashlib
import logging
from datetime import datetime, timezone
from typing import Optional, List, Dict, Any
from uuid import UUID

from app.services.redis_service import RedisStorage
from app.core.config import get_settings

logger = logging.getLogger(__name__)


class LinkRecord:
    """Interview link record"""

    def __init__(
        self,
        session_id: str,
        agent_id: str,
        status: str = "pending",
        created_at: Optional[str] = None,
        expires_at: Optional[str] = None,
        started_at: Optional[int] = None,
        ended_at: Optional[int] = None,
    ):
        self.session_id = session_id
        self.agent_id = agent_id
        self.status = status
        self.created_at = created_at or datetime.now(timezone.utc).isoformat()
        self.expires_at = expires_at
        self.started_at = started_at
        self.ended_at = ended_at

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for storage"""
        return {
            "session_id": self.session_id,
            "agent_id": self.agent_id,
            "status": self.status,
            "created_at": self.created_at,
            "expires_at": self.expires_at,
            "started_at": self.started_at,
            "ended_at": self.ended_at,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "LinkRecord":
        """Create from dictionary"""
        return cls(
            session_id=data["session_id"],
            agent_id=data["agent_id"],
            status=data.get("status", "pending"),
            created_at=data.get("created_at"),
            expires_at=data.get("expires_at"),
            started_at=data.get("started_at"),
            ended_at=data.get("ended_at"),
        )


class LinksService:
    """Service for managing interview links"""

    def __init__(self):
        self.redis = RedisStorage(key_prefix="link")
        self.settings = get_settings()

    def _b64url(self, b: bytes) -> str:
        """Encode bytes as URL-safe base64"""
        return base64.urlsafe_b64encode(b).rstrip(b"=").decode()

    def mint_modtok(self, session_id: str, ttl_s: int) -> str:
        """
        Generate moderator token
        Format: base64url(hmac(secret, sessionId|exp)).exp
        """
        exp = int(time.time()) + ttl_s
        msg = f"{session_id}|{exp}".encode()
        sig = hmac.new(
            self.settings.MOD_TOKEN_SECRET.encode(), msg, hashlib.sha256
        ).digest()
        return f"{self._b64url(sig)}.{exp}"

    def verify_modtok(self, session_id: str, token: str) -> bool:
        """
        Verify moderator token
        Returns True if signature valid and not expired
        """
        try:
            sig_b64, exp_s = token.split(".")
            exp_time = int(exp_s)

            # Check expiry
            if time.time() > exp_time:
                logger.warning(f"Moderator token expired for session {session_id}")
                return False

            # Verify signature
            msg = f"{session_id}|{exp_s}".encode()
            expected_sig = self._b64url(
                hmac.new(
                    self.settings.MOD_TOKEN_SECRET.encode(), msg, hashlib.sha256
                ).digest()
            )

            if not hmac.compare_digest(sig_b64, expected_sig):
                logger.warning(f"Invalid moderator token signature for session {session_id}")
                return False

            return True

        except Exception as e:
            logger.error(f"Error verifying moderator token: {e}")
            return False

    async def create_link(
        self, agent_id: str, max_minutes: Optional[int] = None, ttl_minutes: Optional[int] = None
    ) -> Dict[str, Any]:
        """
        Create a new interview link
        Returns dict with sessionId, candidateUrl, moderatorUrl
        """
        # Check link limit for agent
        count = await self.count_agent_links(agent_id, statuses=["pending", "active"])
        if count >= self.settings.AGENT_MAX_LINKS:
            raise ValueError(
                f"Agent has reached maximum link limit ({self.settings.AGENT_MAX_LINKS})"
            )

        # Generate unique session ID
        from uuid import uuid4
        session_id = str(uuid4())

        # Calculate expiry
        ttl = ttl_minutes or self.settings.LINK_TTL_MINUTES
        expires_at = datetime.fromtimestamp(
            time.time() + (ttl * 60), tz=timezone.utc
        ).isoformat()

        # Create link record
        link = LinkRecord(
            session_id=session_id,
            agent_id=agent_id,
            status="pending",
            expires_at=expires_at,
        )

        # Store in Redis
        await self.redis.set_json(session_id, link.to_dict(), ttl=ttl * 60)

        # Add to agent index
        await self._add_to_agent_index(agent_id, session_id)

        # Generate moderator token (same TTL as link)
        mod_tok = self.mint_modtok(session_id, ttl * 60)

        # Generate URLs
        candidate_url = f"/join/{session_id}"
        moderator_url = f"/monitor/{session_id}?modTok={mod_tok}"

        logger.info(f"Created link for agent {agent_id}, session {session_id}")

        return {
            "sessionId": session_id,
            "candidateUrl": candidate_url,
            "moderatorUrl": moderator_url,
            "expiresAt": expires_at,
        }

    async def get_link(self, session_id: str) -> Optional[LinkRecord]:
        """Get link record by session ID"""
        data = await self.redis.get_json(session_id)
        if data:
            return LinkRecord.from_dict(data)
        return None

    async def update_link_status(
        self,
        session_id: str,
        status: str,
        started_at: Optional[int] = None,
        ended_at: Optional[int] = None,
    ) -> bool:
        """Update link status"""
        link = await self.get_link(session_id)
        if not link:
            return False

        link.status = status
        if started_at is not None:
            link.started_at = started_at
        if ended_at is not None:
            link.ended_at = ended_at

        # Get remaining TTL, or use default if not available
        ttl = await self._get_ttl(session_id)
        if ttl is None:
            # Fallback to default TTL if key has no TTL
            ttl = self.settings.LINK_TTL_MINUTES * 60
        await self.redis.set_json(session_id, link.to_dict(), ttl=ttl)

        logger.info(f"Updated link {session_id} status to {status}")
        return True

    async def list_agent_links(
        self, agent_id: str, status_filter: Optional[str] = None, limit: int = 10
    ) -> List[Dict[str, Any]]:
        """List links for an agent"""
        # Get session IDs from agent index
        session_ids = await self._get_agent_index(agent_id)

        # Fetch link records
        links = []
        for session_id in session_ids[-limit:]:  # Last N links
            link = await self.get_link(session_id)
            if link:
                if status_filter is None or link.status == status_filter:
                    links.append(link.to_dict())

        # Sort by creation time (newest first)
        links.sort(key=lambda x: x["created_at"], reverse=True)

        return links

    async def count_agent_links(
        self, agent_id: str, statuses: Optional[List[str]] = None
    ) -> int:
        """Count links for an agent with optional status filter"""
        session_ids = await self._get_agent_index(agent_id)

        if not statuses:
            return len(session_ids)

        # Count links with matching status
        count = 0
        for session_id in session_ids:
            link = await self.get_link(session_id)
            if link and link.status in statuses:
                count += 1

        return count

    async def delete_link(self, session_id: str) -> bool:
        """Delete/cancel a link"""
        link = await self.get_link(session_id)
        if not link:
            return False

        # Update status to expired
        await self.update_link_status(session_id, "expired")

        # Note: We keep the record for history but mark as expired
        # Redis TTL will eventually clean it up

        logger.info(f"Deleted link {session_id}")
        return True

    async def _add_to_agent_index(self, agent_id: str, session_id: str):
        """Add session to agent's index set"""
        index_key = f"link_idx:{agent_id}"
        # Get existing index
        existing = await self.redis.get(index_key)
        session_ids = existing.split(",") if existing else []
        session_ids.append(session_id)

        # Store updated index (with same TTL as longest link)
        ttl = self.settings.LINK_TTL_MINUTES * 60 * 2  # Double the link TTL
        await self.redis.set(index_key, ",".join(session_ids), ttl=ttl)

    async def _get_agent_index(self, agent_id: str) -> List[str]:
        """Get agent's index of session IDs"""
        index_key = f"link_idx:{agent_id}"
        existing = await self.redis.get(index_key)
        if existing:
            return existing.split(",")
        return []

    async def _get_ttl(self, session_id: str) -> Optional[int]:
        """Get remaining TTL for a key"""
        try:
            ttl = await self.redis.ttl(session_id)
            return ttl if ttl and ttl > 0 else None
        except Exception as e:
            logger.error(f"Error getting TTL: {e}")
            return None













# Global service instance
_links_service: Optional[LinksService] = None


def get_links_service() -> LinksService:
    """Get or create links service singleton"""
    global _links_service
    if _links_service is None:
        _links_service = LinksService()
    return _links_service
