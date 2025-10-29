"""
Sessions Storage Service
Manages persistent storage of interview sessions with status tracking
Uses Redis for storage
"""

import json
import uuid
import asyncio
from datetime import datetime
from typing import Dict, List, Optional
from enum import Enum
from dataclasses import dataclass

from ..core.logging_config import get_logger
from .redis_service import RedisStorage

logger = get_logger(__name__)


class SessionStatus(str, Enum):
    """Session status values"""
    ACTIVE = "active"
    PAUSED = "paused"  # Candidate disconnected but can rejoin
    ENDED = "ended"  # Explicitly ended, cannot rejoin
    EXPIRED = "expired"  # Time limit reached
    DROPPED = "dropped"  # Network issue, can potentially rejoin


@dataclass
class SessionData:
    """Session data model"""
    
    def __init__(
        self,
        session_id: str,
        meeting_id: str,
        agent_id: str,
        eleven_agent_id: str,
        status: SessionStatus = SessionStatus.ACTIVE,
        jwt_token: Optional[str] = None,
        jwt_expiry: Optional[float] = None,
        max_interview_minutes: Optional[int] = None,
        start_time: Optional[float] = None,
        end_time: Optional[float] = None,
        last_activity: Optional[float] = None,
        interview_start_time: Optional[float] = None,
        dynamic_variables: Optional[Dict[str, str]] = None,
        end_reason: Optional[str] = None,
        can_rejoin: bool = True,
        created_at: Optional[str] = None,
        updated_at: Optional[str] = None,
    ):
        self.session_id = session_id
        self.meeting_id = meeting_id  # Jitsi room name
        self.agent_id = agent_id
        self.eleven_agent_id = eleven_agent_id
        self.status = SessionStatus(status) if isinstance(status, str) else status
        self.jwt_token = jwt_token
        self.jwt_expiry = jwt_expiry
        self.max_interview_minutes = max_interview_minutes
        self.start_time = start_time
        self.end_time = end_time
        import time as time_module
        self.last_activity = last_activity or (time_module.time() if start_time else None)
        self.interview_start_time = interview_start_time
        self.dynamic_variables = dynamic_variables or {}
        self.end_reason = end_reason
        self.can_rejoin = can_rejoin
        self.created_at = created_at or datetime.utcnow().isoformat()
        self.updated_at = updated_at or datetime.utcnow().isoformat()
    
    def to_dict(self) -> Dict:
        """Convert to dictionary"""
        return {
            "sessionId": self.session_id,
            "meetingId": self.meeting_id,
            "agentId": self.agent_id,
            "elevenAgentId": self.eleven_agent_id,
            "status": self.status.value,
            "jwtToken": self.jwt_token,
            "jwtExpiry": self.jwt_expiry,
            "maxInterviewMinutes": self.max_interview_minutes,
            "startTime": self.start_time,
            "endTime": self.end_time,
            "lastActivity": self.last_activity,
            "interviewStartTime": self.interview_start_time,
            "dynamicVariables": self.dynamic_variables,
            "endReason": self.end_reason,
            "canRejoin": self.can_rejoin,
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
        }
    
    @staticmethod
    def from_dict(data: Dict) -> "SessionData":
        """Create from dictionary"""
        import time
        session = SessionData(
            session_id=data["sessionId"],
            meeting_id=data["meetingId"],
            agent_id=data["agentId"],
            eleven_agent_id=data["elevenAgentId"],
            status=SessionStatus(data["status"]),
            jwt_token=data.get("jwtToken"),
            jwt_expiry=data.get("jwtExpiry"),
            max_interview_minutes=data.get("maxInterviewMinutes"),
            start_time=data.get("startTime"),
            end_time=data.get("endTime"),
            last_activity=data.get("lastActivity"),
            interview_start_time=data.get("interviewStartTime"),
            dynamic_variables=data.get("dynamicVariables", {}),
            end_reason=data.get("endReason"),
            can_rejoin=data.get("canRejoin", True),
            created_at=data.get("createdAt"),
            updated_at=data.get("updatedAt"),
        )
        return session


class SessionsService:
    """Service for managing session storage using Redis"""
    
    def __init__(self):
        self.redis = RedisStorage(key_prefix="session")
        self._sessions: Dict[str, SessionData] = {}
        # Load sessions on init (async, but we'll do it synchronously if Redis is available)
    
    async def _load_sessions(self):
        """Load sessions from Redis"""
        try:
            sessions_data = await self.redis.get_all_json("*")
            self._sessions = {
                session_id: SessionData.from_dict(data)
                for session_id, data in sessions_data.items()
            }
            logger.info("Loaded %d sessions from Redis", len(self._sessions))
        except Exception as e:
            logger.error("Failed to load sessions from Redis: %s", str(e), exc_info=True)
            self._sessions = {}
    
    async def _save_session(self, session: SessionData):
        """Save a single session to Redis"""
        try:
            session_id = session.session_id
            success = await self.redis.set_json(session_id, session.to_dict())
            if success:
                logger.debug("Saved session to Redis: %s", session_id)
            else:
                logger.error("Failed to save session to Redis: %s", session_id)
        except Exception as e:
            logger.error("Failed to save session to Redis: %s", str(e), exc_info=True)
    
    async def create_session(
        self,
        session_id: str,
        meeting_id: str,
        agent_id: str,
        eleven_agent_id: str,
        jwt_token: str,
        jwt_expiry: float,
        max_interview_minutes: Optional[int] = None,
        dynamic_variables: Optional[Dict[str, str]] = None,
    ) -> SessionData:
        """Create a new session"""
        import time as time_module
        session = SessionData(
            session_id=session_id,
            meeting_id=meeting_id,
            agent_id=agent_id,
            eleven_agent_id=eleven_agent_id,
            status=SessionStatus.ACTIVE,
            jwt_token=jwt_token,
            jwt_expiry=jwt_expiry,
            max_interview_minutes=max_interview_minutes,
            start_time=time_module.time(),
            last_activity=time_module.time(),
            dynamic_variables=dynamic_variables or {},
            can_rejoin=True,
        )
        self._sessions[session_id] = session
        await self._save_session(session)
        logger.info("Created session: %s (meeting: %s)", session_id, meeting_id)
        return session
    
    async def get_session(self, session_id: str) -> Optional[SessionData]:
        """Get a session by ID (from cache or Redis)"""
        # Check in-memory cache first
        if session_id in self._sessions:
            return self._sessions[session_id]
        
        # Load from Redis if not in cache
        try:
            data = await self.redis.get_json(session_id)
            if data:
                session = SessionData.from_dict(data)
                self._sessions[session_id] = session  # Cache it
                return session
        except Exception as e:
            logger.error("Failed to get session from Redis: %s", str(e))
        
        return None
    
    async def get_session_by_meeting(self, meeting_id: str) -> Optional[SessionData]:
        """Get a session by meeting ID"""
        # Load all sessions if cache is empty
        if not self._sessions:
            await self._load_sessions()
        
        for session in self._sessions.values():
            if session.meeting_id == meeting_id:
                return session
        return None
    
    async def update_session(
        self,
        session_id: str,
        status: Optional[SessionStatus] = None,
        interview_start_time: Optional[float] = None,
        last_activity: Optional[float] = None,
        end_time: Optional[float] = None,
        end_reason: Optional[str] = None,
        can_rejoin: Optional[bool] = None,
    ) -> Optional[SessionData]:
        """Update session properties"""
        # Load from Redis if not in cache
        session = await self.get_session(session_id)
        if not session:
            logger.warning("Session not found for update: %s", session_id)
            return None
        
        import time as time_module
        if status is not None:
            session.status = status
        if interview_start_time is not None:
            session.interview_start_time = interview_start_time
        if last_activity is not None:
            session.last_activity = last_activity
        elif status == SessionStatus.ACTIVE:
            # Auto-update last activity if session is active
            session.last_activity = time_module.time()
        if end_time is not None:
            session.end_time = end_time
        if end_reason is not None:
            session.end_reason = end_reason
        if can_rejoin is not None:
            session.can_rejoin = can_rejoin
        
        session.updated_at = datetime.utcnow().isoformat()
        await self._save_session(session)
        logger.debug("Updated session: %s", session_id)
        return session
    
    async def end_session(
        self,
        session_id: str,
        reason: str,
        can_rejoin: bool = False,
    ) -> Optional[SessionData]:
        """Explicitly end a session"""
        import time as time_module
        return await self.update_session(
            session_id=session_id,
            status=SessionStatus.ENDED,
            end_time=time_module.time(),
            end_reason=reason,
            can_rejoin=can_rejoin,
        )
    
    async def mark_dropped(
        self,
        session_id: str,
        reason: str = "network_issue",
    ) -> Optional[SessionData]:
        """Mark session as dropped (can rejoin)"""
        import time as time_module
        session = await self.update_session(
            session_id=session_id,
            status=SessionStatus.DROPPED,
            end_reason=reason,
            can_rejoin=True,
        )
        if session:
            logger.info("Marked session as dropped: %s (reason: %s)", session_id, reason)
        return session
    
    async def resume_session(self, session_id: str) -> Optional[SessionData]:
        """Resume a dropped/paused session"""
        session = await self.get_session(session_id)
        if not session:
            return None
        
        if not session.can_rejoin:
            logger.warning("Session %s cannot be rejoined (status: %s)", session_id, session.status.value)
            return None
        
        if session.status not in [SessionStatus.DROPPED, SessionStatus.PAUSED]:
            logger.warning("Session %s cannot be resumed from status: %s", session_id, session.status.value)
            return None
        
        import time as time_module
        session.status = SessionStatus.ACTIVE
        session.last_activity = time_module.time()
        session.end_time = None  # Clear end time when resuming
        session.updated_at = datetime.utcnow().isoformat()
        await self._save_session(session)
        logger.info("Resumed session: %s", session_id)
        return session
    
    async def list_sessions(
        self,
        status: Optional[SessionStatus] = None,
        agent_id: Optional[str] = None,
        limit: Optional[int] = None,
    ) -> List[SessionData]:
        """List sessions, optionally filtered by status and/or agent_id"""
        # Load all sessions from Redis
        await self._load_sessions()
        
        sessions = list(self._sessions.values())
        
        if status:
            sessions = [s for s in sessions if s.status == status]
        
        if agent_id:
            sessions = [s for s in sessions if s.agent_id == agent_id]
        
        # Sort by updated_at descending
        sessions.sort(key=lambda s: s.updated_at or "", reverse=True)
        
        if limit:
            sessions = sessions[:limit]
        
        return sessions
    
    async def delete_session(self, session_id: str) -> bool:
        """Delete a session from Redis"""
        try:
            success = await self.redis.delete(session_id)
            if success:
                # Remove from cache
                if session_id in self._sessions:
                    del self._sessions[session_id]
                logger.info("Deleted session: %s", session_id)
            return success
        except Exception as e:
            logger.error("Failed to delete session from Redis: %s", str(e))
            return False


# Global service instance
_sessions_service: Optional[SessionsService] = None


def get_sessions_service() -> SessionsService:
    """Get the global sessions service instance"""
    global _sessions_service
    if _sessions_service is None:
        _sessions_service = SessionsService()
    return _sessions_service

