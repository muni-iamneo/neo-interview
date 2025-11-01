"""
Links Router: API endpoints for managing interview links
"""

import logging
from typing import Optional, List
from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field

from app.services.links_service import get_links_service
from app.services.session_config import set_session_config
from app.services.agents_service import get_agents_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/links", tags=["links"])


# Request/Response Models
class CreateLinkRequest(BaseModel):
    """Request to create a new interview link"""

    agentId: str = Field(..., description="Agent ID to use for this interview")
    maxMinutes: Optional[int] = Field(None, description="Maximum interview duration in minutes")
    ttlMinutes: Optional[int] = Field(None, description="Link expiry time in minutes")


class CreateLinkResponse(BaseModel):
    """Response after creating a link"""

    sessionId: str
    candidateUrl: str
    moderatorUrl: str
    meetingUrl: str
    roomName: str
    expiresAt: str


class LinkInfo(BaseModel):
    """Link information"""

    session_id: str
    agent_id: str
    status: str
    created_at: str
    expires_at: Optional[str]
    started_at: Optional[int]
    ended_at: Optional[int]
    meeting_url: Optional[str] = None
    room_name: Optional[str] = None


@router.post("/", status_code=status.HTTP_201_CREATED, response_model=CreateLinkResponse)
async def create_link(request: CreateLinkRequest):
    """
    Create a new interview link

    This endpoint:
    1. Validates agent exists
    2. Allocates a session ID
    3. Sets session configuration with agent
    4. Persists link in Redis
    5. Generates moderator token
    6. Returns candidate and moderator URLs
    """
    try:
        links_service = get_links_service()
        agents_service = get_agents_service()

        # Validate agent exists
        agent = await agents_service.get_agent(request.agentId)
        if not agent:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Agent {request.agentId} not found"
            )

        # Create link (generates session ID)
        link_data = await links_service.create_link(
            agent_id=request.agentId,
            max_minutes=request.maxMinutes or agent.max_interview_minutes,
            ttl_minutes=request.ttlMinutes,
        )

        session_id = link_data["sessionId"]

        # Set session config (in-memory) for when JWT is minted
        set_session_config(
            session_id=session_id,
            eleven_agent_id=agent.eleven_agent_id,
            dynamic_variables={},
            max_interview_minutes=request.maxMinutes or agent.max_interview_minutes,
        )

        # Generate meeting room name and URL
        room_name = f"interview-{session_id[:8]}"
        from app.core.config import get_settings
        settings = get_settings()
        meeting_url = f"https://{settings.JAA_EMBED_DOMAIN}/{settings.get_effective_tenant()}/{room_name}"

        logger.info(
            f"Created link for agent {request.agentId}, session {session_id}, room {room_name}"
        )

        return CreateLinkResponse(
            sessionId=link_data["sessionId"],
            candidateUrl=link_data["candidateUrl"],
            moderatorUrl=link_data["moderatorUrl"],
            meetingUrl=meeting_url,
            roomName=room_name,
            expiresAt=link_data["expiresAt"],
        )

    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(e)
        )
    except Exception as e:
        logger.error(f"Error creating link: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to create link",
        )


@router.get("/agent/{agent_id}", response_model=List[LinkInfo])
async def list_agent_links(
    agent_id: str,
    status_filter: Optional[str] = None,
    limit: int = 10
):
    """
    List links for an agent

    Optionally filter by status and limit results.
    Results are sorted by creation time (newest first).
    """
    try:
        links_service = get_links_service()

        # Validate agent exists
        agents_service = get_agents_service()
        agent = await agents_service.get_agent(agent_id)
        if not agent:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Agent {agent_id} not found"
            )

        # Fetch links
        links = await links_service.list_agent_links(
            agent_id=agent_id,
            status_filter=status_filter,
            limit=limit,
        )

        from app.core.config import get_settings
        settings = get_settings()

        return [
            LinkInfo(
                session_id=link["session_id"],
                agent_id=link["agent_id"],
                status=link["status"],
                created_at=link["created_at"],
                expires_at=link.get("expires_at"),
                started_at=link.get("started_at"),
                ended_at=link.get("ended_at"),
                room_name=f"interview-{link['session_id'][:8]}",
                meeting_url=f"https://{settings.JAA_EMBED_DOMAIN}/{settings.get_effective_tenant()}/interview-{link['session_id'][:8]}",
            )
            for link in links
        ]

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error listing agent links: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to list links",
        )


@router.delete("/{session_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_link(session_id: str):
    """
    Delete/cancel an interview link

    Marks the link as expired. The link record is kept for history
    but will no longer be usable.
    """
    try:
        links_service = get_links_service()

        # Check link exists
        link = await links_service.get_link(session_id)
        if not link:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Link {session_id} not found"
            )

        # Delete link
        success = await links_service.delete_link(session_id)
        if not success:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to delete link",
            )

        logger.info(f"Deleted link {session_id}")

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting link: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to delete link",
        )


@router.get("/{session_id}", response_model=LinkInfo)
async def get_link(session_id: str):
    """
    Get link details by session ID
    """
    try:
        links_service = get_links_service()
        link = await links_service.get_link(session_id)

        if not link:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Link {session_id} not found"
            )

        return LinkInfo(
            session_id=link.session_id,
            agent_id=link.agent_id,
            status=link.status,
            created_at=link.created_at,
            expires_at=link.expires_at,
            started_at=link.started_at,
            ended_at=link.ended_at,
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting link: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to get link",
        )
