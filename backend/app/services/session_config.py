"""
Session Configuration Service
Manages per-session agent configuration for voice conversations
"""

from typing import Dict, Optional
from dataclasses import dataclass

from ..core.logging_config import get_logger

logger = get_logger(__name__)


@dataclass
class SessionConfig:
    """Configuration for a voice session"""
    eleven_agent_id: str
    dynamic_variables: Dict[str, str]
    max_interview_minutes: Optional[int] = None
    agent_id: Optional[str] = None  # Internal agent ID for fetching agent configuration


# In-memory session configuration store
_session_configs: Dict[str, SessionConfig] = {}


def set_session_config(session_id: str, eleven_agent_id: str, dynamic_variables: Optional[Dict[str, str]] = None, max_interview_minutes: Optional[int] = None, agent_id: Optional[str] = None):
    """Set configuration for a session"""
    config = SessionConfig(
        eleven_agent_id=eleven_agent_id,
        dynamic_variables=dynamic_variables or {},
        max_interview_minutes=max_interview_minutes,
        agent_id=agent_id
    )
    _session_configs[session_id] = config
    logger.info("Session config set: session=%s agent=%s agent_id=%s max_minutes=%s", session_id, eleven_agent_id, agent_id, max_interview_minutes)


def get_session_config(session_id: str) -> Optional[SessionConfig]:
    """Get configuration for a session"""
    return _session_configs.get(session_id)


def clear_session_config(session_id: str):
    """Clear configuration for a session"""
    if session_id in _session_configs:
        del _session_configs[session_id]
        logger.debug("Session config cleared: session=%s", session_id)

