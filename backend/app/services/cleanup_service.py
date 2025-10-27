"""
Session Cleanup Service
Handles automatic cleanup of expired sessions and resources
"""

import asyncio
from typing import Dict, Set, TYPE_CHECKING
from datetime import datetime, timedelta

from ..core.config import get_settings
from ..core.logging_config import get_logger

if TYPE_CHECKING:
    from .voice_endpoint import IntegratedVoiceSession

settings = get_settings()
logger = get_logger(__name__)


class SessionCleanupService:
    """Background service for cleaning up expired sessions"""
    
    def __init__(self):
        self._cleanup_task: asyncio.Task | None = None
        self._is_running = False
        self._session_last_activity: Dict[str, datetime] = {}
        
    async def start(self):
        """Start the cleanup background task"""
        if self._is_running:
            logger.warning("Cleanup service already running")
            return
            
        self._is_running = True
        self._cleanup_task = asyncio.create_task(self._cleanup_loop())
        logger.info("Session cleanup service started (interval: %ds, timeout: %ds)",
                   settings.SESSION_CLEANUP_INTERVAL,
                   settings.SESSION_TIMEOUT_SECONDS)
    
    async def stop(self):
        """Stop the cleanup background task"""
        if not self._is_running:
            return
            
        self._is_running = False
        
        if self._cleanup_task:
            self._cleanup_task.cancel()
            try:
                await self._cleanup_task
            except asyncio.CancelledError:
                pass
            self._cleanup_task = None
            
        logger.info("Session cleanup service stopped")
    
    async def _cleanup_loop(self):
        """Main cleanup loop"""
        while self._is_running:
            try:
                await asyncio.sleep(settings.SESSION_CLEANUP_INTERVAL)
                await self._cleanup_expired_sessions()
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error("Error in cleanup loop: %s", str(e), exc_info=True)
    
    async def _cleanup_expired_sessions(self):
        """Find and remove expired sessions"""
        now = datetime.utcnow()
        timeout = timedelta(seconds=settings.SESSION_TIMEOUT_SECONDS)
        
        expired_sessions: Set[str] = set()
        
        for session_id, last_activity in list(self._session_last_activity.items()):
            if now - last_activity > timeout:
                expired_sessions.add(session_id)
        
        if expired_sessions:
            logger.info("Found %d expired sessions to clean up", len(expired_sessions))
            
            # Import here to avoid circular dependency
            from .voice_endpoint import active_sessions
            
            for session_id in expired_sessions:
                if session_id in active_sessions:
                    session = active_sessions[session_id]
                    try:
                        await session.cleanup()
                        del active_sessions[session_id]
                        logger.info("Cleaned up expired session: %s", session_id)
                    except Exception as e:
                        logger.error("Error cleaning up session %s: %s", session_id, str(e))
                
                # Remove from tracking
                if session_id in self._session_last_activity:
                    del self._session_last_activity[session_id]
    
    def register_session(self, session_id: str):
        """Register a new session for tracking"""
        self._session_last_activity[session_id] = datetime.utcnow()
        logger.debug("Registered session for cleanup tracking: %s", session_id)
    
    def update_session_activity(self, session_id: str):
        """Update session last activity timestamp"""
        self._session_last_activity[session_id] = datetime.utcnow()
    
    def unregister_session(self, session_id: str):
        """Remove session from tracking"""
        if session_id in self._session_last_activity:
            del self._session_last_activity[session_id]
            logger.debug("Unregistered session from cleanup tracking: %s", session_id)


# Global instance
_cleanup_service: SessionCleanupService | None = None


def get_cleanup_service() -> SessionCleanupService:
    """Get or create global cleanup service instance"""
    global _cleanup_service
    if _cleanup_service is None:
        _cleanup_service = SessionCleanupService()
    return _cleanup_service

