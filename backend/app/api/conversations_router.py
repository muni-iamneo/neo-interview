"""
API Router for Conversations and Analysis endpoints.
"""
from typing import List, Dict, Any, Optional
from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, Field

from ..services.conversations_service import get_conversations_service
from ..services.analysis_service import get_analysis_service
from ..core.logging_config import get_logger

logger = get_logger(__name__)

router = APIRouter(prefix="/api/conversations", tags=["conversations"])


# Pydantic Models
class ConversationInfo(BaseModel):
    """Basic conversation information."""
    conversation_id: str = Field(..., description="Unique conversation identifier")
    agent_id: str = Field(..., description="ElevenLabs agent ID")
    start_time: str = Field(..., description="Conversation start timestamp")
    call_duration_secs: int = Field(..., description="Duration in seconds")
    status: str = Field(..., description="Conversation status")


class TranscriptSegment(BaseModel):
    """Single segment of conversation transcript."""
    role: str = Field(..., description="Speaker role (agent or user)")
    message: str = Field(..., description="Spoken message")
    timestamp: Optional[float] = Field(None, description="Timestamp in seconds")


class ConversationDetails(BaseModel):
    """Detailed conversation information with transcript."""
    conversation_id: str
    agent_id: str
    transcript: List[Dict[str, Any]]
    formatted_transcript: str
    metadata: Dict[str, Any] = Field(default_factory=dict)


class AnalysisResult(BaseModel):
    """AI-generated interview analysis."""
    conversation_id: str
    agent_id: Optional[str] = None
    analysis: Dict[str, Any] = Field(
        ...,
        description="Analysis containing hiring_recommendation, subject_knowledge, reasoning, strengths, concerns"
    )
    generated_at: str


class ConversationsListResponse(BaseModel):
    """Paginated list of conversations."""
    conversations: List[Dict[str, Any]]
    next_cursor: Optional[str] = Field(None, description="Cursor for next page")


class AnalyzeRequest(BaseModel):
    """Request to generate analysis."""
    force_regenerate: bool = Field(
        default=False,
        description="If true, regenerate analysis even if cached version exists"
    )


@router.get(
    "/agent/{agent_id}",
    response_model=ConversationsListResponse,
    status_code=status.HTTP_200_OK,
    summary="List conversations for an agent"
)
async def list_agent_conversations(
    agent_id: str,
    cursor: Optional[str] = Query(None, description="Pagination cursor"),
    page_size: int = Query(30, ge=1, le=100, description="Number of conversations per page")
):
    """
    Retrieve paginated list of conversations for a specific agent.
    Only includes conversations with duration >= configured minimum (default 90 seconds).
    """
    try:
        conversations_service = get_conversations_service()
        conversations, next_cursor = await conversations_service.list_conversations(
            agent_id=agent_id,
            cursor=cursor,
            page_size=page_size
        )

        return ConversationsListResponse(
            conversations=conversations,
            next_cursor=next_cursor
        )

    except ValueError as e:
        logger.error(f"Validation error listing conversations: {str(e)}")
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Error listing conversations for agent {agent_id}: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to fetch conversations")


@router.get(
    "/{conversation_id}",
    response_model=ConversationDetails,
    status_code=status.HTTP_200_OK,
    summary="Get conversation details"
)
async def get_conversation(conversation_id: str):
    """
    Retrieve detailed information about a specific conversation including transcript.
    """
    try:
        conversations_service = get_conversations_service()
        conversation_details = await conversations_service.get_conversation_details(conversation_id)

        return ConversationDetails(
            conversation_id=conversation_details.get("conversation_id", conversation_id),
            agent_id=conversation_details.get("agent_id", ""),
            transcript=conversation_details.get("transcript", []),
            formatted_transcript=conversation_details.get("formatted_transcript", ""),
            metadata={
                k: v for k, v in conversation_details.items()
                if k not in ["conversation_id", "agent_id", "transcript", "formatted_transcript"]
            }
        )

    except ValueError as e:
        logger.error(f"Validation error getting conversation: {str(e)}")
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        logger.error(f"Error getting conversation {conversation_id}: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to fetch conversation details")


@router.post(
    "/{conversation_id}/analyze",
    response_model=AnalysisResult,
    status_code=status.HTTP_200_OK,
    summary="Generate AI analysis for conversation"
)
async def analyze_conversation(
    conversation_id: str,
    request: AnalyzeRequest = AnalyzeRequest()
):
    """
    Generate or retrieve AI-powered analysis of interview conversation.
    Returns cached analysis if available, unless force_regenerate is true.
    """
    try:
        analysis_service = get_analysis_service()
        analysis_data = await analysis_service.generate_analysis(
            conversation_id=conversation_id,
            force_regenerate=request.force_regenerate
        )

        return AnalysisResult(**analysis_data)

    except ValueError as e:
        logger.error(f"Validation error analyzing conversation: {str(e)}")
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Error analyzing conversation {conversation_id}: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to generate analysis")


@router.get(
    "/{conversation_id}/analysis",
    response_model=AnalysisResult,
    status_code=status.HTTP_200_OK,
    summary="Get stored analysis"
)
async def get_conversation_analysis(conversation_id: str):
    """
    Retrieve previously generated analysis for a conversation.
    Returns 404 if no analysis exists.
    """
    try:
        analysis_service = get_analysis_service()
        analysis_data = await analysis_service.get_analysis(conversation_id)

        if not analysis_data:
            raise HTTPException(
                status_code=404,
                detail=f"No analysis found for conversation {conversation_id}"
            )

        return AnalysisResult(**analysis_data)

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting analysis for {conversation_id}: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to retrieve analysis")


@router.delete(
    "/{conversation_id}/analysis",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete stored analysis"
)
async def delete_conversation_analysis(conversation_id: str):
    """
    Delete stored analysis for a conversation.
    """
    try:
        analysis_service = get_analysis_service()
        deleted = await analysis_service.delete_analysis(conversation_id)

        if not deleted:
            raise HTTPException(
                status_code=404,
                detail=f"No analysis found for conversation {conversation_id}"
            )

        return None

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting analysis for {conversation_id}: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to delete analysis")
