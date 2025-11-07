"""
Session Configuration API Router
Endpoints for configuring voice sessions
"""

from typing import Dict, Optional
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..services.session_config import set_session_config
from ..services.agents_service import get_agents_service
from ..services.sessions_service import get_sessions_service
from ..core.logging_config import get_logger

logger = get_logger(__name__)
router = APIRouter(prefix="/voice/sessions", tags=["sessions"])


class ConfigureSessionRequest(BaseModel):
    """Request model for configuring a session"""
    agentId: Optional[str] = Field(None, description="Local agent ID to use")
    elevenAgentId: Optional[str] = Field(None, description="Direct ElevenLabs agent ID")
    dynamicVariables: Optional[Dict[str, str]] = Field(default_factory=dict, description="Dynamic variables for the conversation")


class ConfigureSessionResponse(BaseModel):
    """Response model for session configuration"""
    success: bool
    sessionId: str
    elevenAgentId: str
    message: str


@router.post("/{session_id}/configure", response_model=ConfigureSessionResponse)
async def configure_session(session_id: str, request: ConfigureSessionRequest):
    """Configure a voice session with agent and dynamic variables"""
    try:
        eleven_agent_id = None
        
        # Resolve ElevenLabs agent ID
        if request.agentId:
            # Look up local agent
            service = get_agents_service()
            agent = await service.get_agent(request.agentId)
            
            if not agent:
                raise HTTPException(status_code=404, detail=f"Agent {request.agentId} not found")
            
            if not agent.eleven_agent_id:
                raise HTTPException(status_code=400, detail="Agent does not have an ElevenLabs agent ID")
            
            eleven_agent_id = agent.eleven_agent_id
            logger.info("Resolved agent %s to ElevenLabs ID %s", request.agentId, eleven_agent_id)
            
        elif request.elevenAgentId:
            # Use direct ElevenLabs ID
            eleven_agent_id = request.elevenAgentId
            logger.info("Using direct ElevenLabs agent ID: %s", eleven_agent_id)
        else:
            raise HTTPException(status_code=400, detail="Either agentId or elevenAgentId must be provided")
        
        # Extract maxInterviewMinutes from agent or dynamicVariables
        max_interview_minutes = None
        if request.agentId:
            max_interview_minutes = agent.max_interview_minutes
        elif request.dynamicVariables and "meeting_duration" in request.dynamicVariables:
            try:
                max_interview_minutes = int(request.dynamicVariables["meeting_duration"])
            except (ValueError, TypeError):
                pass
        
        # Set session configuration
        set_session_config(
            session_id=session_id,
            eleven_agent_id=eleven_agent_id,
            dynamic_variables=request.dynamicVariables or {},
            max_interview_minutes=max_interview_minutes,
            agent_id=request.agentId,  # Pass agent ID so voice endpoint can fetch voice_provider from Redis
        )
        
        logger.info("Session configured: session=%s agent=%s vars=%s", 
                   session_id, eleven_agent_id, list(request.dynamicVariables.keys()) if request.dynamicVariables else [])
        
        return ConfigureSessionResponse(
            success=True,
            sessionId=session_id,
            elevenAgentId=eleven_agent_id,
            message="Session configured successfully"
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Failed to configure session: %s", str(e), exc_info=True)
        raise HTTPException(status_code=500, detail="Internal server error")


@router.post("/{session_id}/resume")
async def resume_session(session_id: str):
    """Resume a dropped/paused session (for rejoin scenarios)"""
    try:
        sessions_service = get_sessions_service()
        session = await sessions_service.resume_session(session_id)
        
        if not session:
            raise HTTPException(status_code=404, detail=f"Session {session_id} not found or cannot be resumed")
        
        logger.info("Session resumed: %s", session_id)
        
        return {
            "success": True,
            "sessionId": session.session_id,
            "status": session.status.value,
            "canRejoin": session.can_rejoin,
            "message": "Session resumed successfully"
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Failed to resume session: %s", str(e), exc_info=True)
        raise HTTPException(status_code=500, detail="Internal server error")


@router.get("/{session_id}/info")
async def get_session_info(session_id: str):
    """Get detailed session information"""
    try:
        sessions_service = get_sessions_service()
        session = await sessions_service.get_session(session_id)
        
        if not session:
            raise HTTPException(status_code=404, detail=f"Session {session_id} not found")
        
        return {
            "sessionId": session.session_id,
            "meetingId": session.meeting_id,
            "agentId": session.agent_id,
            "status": session.status.value,
            "canRejoin": session.can_rejoin,
            "startTime": session.start_time,
            "endTime": session.end_time,
            "lastActivity": session.last_activity,
            "interviewStartTime": session.interview_start_time,
            "maxInterviewMinutes": session.max_interview_minutes,
            "endReason": session.end_reason,
            "createdAt": session.created_at,
            "updatedAt": session.updated_at,
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Failed to get session info: %s", str(e), exc_info=True)
        raise HTTPException(status_code=500, detail="Internal server error")


@router.get("/agent/{agent_id}/history")
async def get_agent_session_history(agent_id: str):
    """Get session history for a specific agent"""
    try:
        sessions_service = get_sessions_service()
        sessions = await sessions_service.list_sessions(agent_id=agent_id, limit=100)
        
        return {
            "agentId": agent_id,
            "sessions": [session.to_dict() for session in sessions],
            "totalCount": len(sessions)
        }
    except Exception as e:
        logger.error("Failed to get agent session history: %s", str(e), exc_info=True)
        raise HTTPException(status_code=500, detail="Internal server error")

