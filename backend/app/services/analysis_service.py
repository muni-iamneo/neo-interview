"""
Interview Analysis Service using AI agents.
"""
from typing import Dict, Any, Optional, List
from datetime import datetime

from ..agents.interview_agent import get_interview_agent
from ..core.logging_config import get_logger
from .redis_service import RedisStorage
from .conversations_service import get_conversations_service

logger = get_logger(__name__)


class AnalysisService:
    """Service for generating and managing interview analysis."""

    def __init__(self):
        self.interview_agent = get_interview_agent()
        self.redis = RedisStorage(key_prefix="conversation_analysis")
        self.conversations_service = get_conversations_service()
        logger.info("Analysis Service initialized")

    async def generate_analysis(
        self,
        conversation_id: str,
        force_regenerate: bool = False
    ) -> Dict[str, Any]:
        """
        Generate AI analysis for a conversation transcript.

        Args:
            conversation_id: The conversation ID to analyze
            force_regenerate: If True, regenerate even if cached analysis exists

        Returns:
            Dictionary containing analysis results
        """
        try:
            # Check if analysis already exists
            if not force_regenerate:
                existing_analysis = await self.get_analysis(conversation_id)
                if existing_analysis:
                    logger.info(f"Returning cached analysis for conversation {conversation_id}")
                    return existing_analysis

            logger.info(f"Generating new analysis for conversation {conversation_id}")

            # Fetch conversation details
            conversation_details = await self.conversations_service.get_conversation_details(conversation_id)
            transcript = conversation_details.get("transcript", [])

            if not transcript:
                raise ValueError("No transcript available for analysis")

            # Format transcript for analysis
            formatted_transcript = self.conversations_service.format_transcript_for_analysis(transcript)

            # Generate analysis using AI agent
            analysis_result = await self.interview_agent.analyze_transcript(formatted_transcript)

            # Add metadata
            analysis_data = {
                "conversation_id": conversation_id,
                "agent_id": conversation_details.get("agent_id"),
                "analysis": analysis_result,
                "generated_at": datetime.utcnow().isoformat()
            }

            # Store in Redis (no TTL - permanent storage)
            await self.redis.set_json(conversation_id, analysis_data)

            logger.info(f"Successfully generated and stored analysis for conversation {conversation_id}")
            return analysis_data

        except Exception as e:
            logger.error(f"Error generating analysis for {conversation_id}: {str(e)}", exc_info=True)
            raise

    async def get_analysis(self, conversation_id: str) -> Optional[Dict[str, Any]]:
        """
        Retrieve stored analysis for a conversation.

        Args:
            conversation_id: The conversation ID

        Returns:
            Analysis data if exists, None otherwise
        """
        try:
            analysis_data = await self.redis.get_json(conversation_id)

            if analysis_data:
                logger.info(f"Found stored analysis for conversation {conversation_id}")
            else:
                logger.info(f"No stored analysis found for conversation {conversation_id}")

            return analysis_data

        except Exception as e:
            logger.error(f"Error retrieving analysis for {conversation_id}: {str(e)}", exc_info=True)
            return None

    async def list_agent_analyses(self, agent_id: str) -> List[Dict[str, Any]]:
        """
        Get all analyses for conversations belonging to a specific agent.

        Args:
            agent_id: The agent ID

        Returns:
            List of analysis data dictionaries
        """
        try:
            # Get all stored analyses
            all_analyses = await self.redis.get_all_json("*")

            # Filter by agent_id
            agent_analyses = [
                analysis for analysis in all_analyses
                if analysis.get("agent_id") == agent_id
            ]

            logger.info(f"Found {len(agent_analyses)} analyses for agent {agent_id}")
            return agent_analyses

        except Exception as e:
            logger.error(f"Error listing analyses for agent {agent_id}: {str(e)}", exc_info=True)
            return []

    async def delete_analysis(self, conversation_id: str) -> bool:
        """
        Delete stored analysis for a conversation.

        Args:
            conversation_id: The conversation ID

        Returns:
            True if deleted successfully, False otherwise
        """
        try:
            await self.redis.delete(conversation_id)
            logger.info(f"Deleted analysis for conversation {conversation_id}")
            return True

        except Exception as e:
            logger.error(f"Error deleting analysis for {conversation_id}: {str(e)}", exc_info=True)
            return False


# Singleton instance
_analysis_service: Optional[AnalysisService] = None


def get_analysis_service() -> AnalysisService:
    """Get or create Analysis Service singleton."""
    global _analysis_service
    if _analysis_service is None:
        _analysis_service = AnalysisService()
    return _analysis_service
