"""
ElevenLabs Conversations API Service
"""
from typing import List, Dict, Any, Optional, Tuple
import httpx

from ..core.config import get_settings
from ..core.logging_config import get_logger
from .redis_service import RedisStorage

logger = get_logger(__name__)


class ConversationsService:
    """Service for interacting with ElevenLabs Conversations API."""

    def __init__(self):
        self.settings = get_settings()
        self.api_key = self.settings.ELEVENLABS_API_KEY
        self.base_url = self.settings.ELEVENLABS_CONVERSATIONS_API_URL
        self.redis = RedisStorage(key_prefix="conversations")
        logger.info("Conversations Service initialized")

    async def list_conversations(
        self,
        agent_id: str,
        cursor: Optional[str] = None,
        page_size: int = 30,
        min_duration_secs: Optional[int] = None
    ) -> Tuple[List[Dict[str, Any]], Optional[str]]:
        """
        List conversations for a specific agent from ElevenLabs API.

        Args:
            agent_id: The ElevenLabs agent ID
            cursor: Optional pagination cursor
            page_size: Number of conversations per page
            min_duration_secs: Minimum call duration to include (uses config default if not provided)

        Returns:
            Tuple of (conversations_list, next_cursor)
        """
        # Use configured minimum duration if not provided
        if min_duration_secs is None:
            min_duration_secs = self.settings.ELEVENLABS_MIN_CONVERSATION_DURATION_SECS

        try:
            # Request conversations and keep fetching until we have enough after filtering
            # We'll make multiple requests if needed to accumulate enough filtered results
            filtered_conversations: List[Dict[str, Any]] = []
            current_cursor = cursor
            requested_size = min(page_size * 3, 100)  # Request 3x, capped at API limit
            max_iterations = 5  # Limit to avoid infinite loops
            iteration = 0
            all_conversations_fetched = 0
            next_cursor: Optional[str] = None

            headers = {
                "xi-api-key": self.api_key,
                "Content-Type": "application/json"
            }

            logger.info(
                f"Fetching conversations for agent_id={agent_id}, cursor={cursor}, "
                f"target_page_size={page_size}, min_duration={min_duration_secs}s"
            )

            async with httpx.AsyncClient(timeout=30.0) as client:
                while len(filtered_conversations) < page_size and iteration < max_iterations:
                    # Build query parameters for this request
                    params = {
                        "agent_id": agent_id,
                        "page_size": requested_size
                    }
                    if current_cursor:
                        params["cursor"] = current_cursor

                    logger.debug(
                        f"Iteration {iteration + 1}: Fetching {requested_size} conversations "
                        f"(cursor: {current_cursor[:20] + '...' if current_cursor and len(current_cursor) > 20 else current_cursor})"
                    )

                    response = await client.get(
                        self.base_url,
                        params=params,
                        headers=headers
                    )

                    if response.status_code == 429:
                        logger.error("ElevenLabs API rate limit exceeded")
                        raise ValueError("Rate limit exceeded. Please try again later.")

                    response.raise_for_status()
                    data = response.json()

                    # Extract conversations and next cursor
                    conversations = data.get("conversations", [])
                    next_cursor = data.get("next_cursor") or data.get("cursor")
                    all_conversations_fetched += len(conversations)

                    # Filter by minimum duration and add to our collection
                    batch_filtered = [
                        conv for conv in conversations
                        if conv.get("call_duration_secs", 0) >= min_duration_secs
                    ]
                    filtered_conversations.extend(batch_filtered)

                    logger.debug(
                        f"Iteration {iteration + 1}: Got {len(conversations)} conversations, "
                        f"{len(batch_filtered)} passed filter, total filtered so far: {len(filtered_conversations)}"
                    )

                    # If we don't have enough and there's no next cursor, we've reached the end
                    if not next_cursor:
                        break

                    # If we have enough, we're done
                    if len(filtered_conversations) >= page_size:
                        break

                    # Prepare for next iteration
                    current_cursor = next_cursor
                    iteration += 1

            # Limit to requested page_size after all fetching is done
            filtered_conversations = filtered_conversations[:page_size]
            
            # Determine the final next_cursor:
            # - If we have exactly page_size results and there was a cursor, keep it
            # - If we have fewer than page_size and no cursor, we've reached the end
            # - If we have fewer but there was a cursor, keep it (more data might be available)
            if len(filtered_conversations) >= page_size:
                # We have enough results, keep the cursor if it exists
                final_next_cursor = next_cursor
            elif next_cursor:
                # We don't have enough but there's more data available
                final_next_cursor = next_cursor
            else:
                # No more data available
                final_next_cursor = None

            logger.info(
                f"Retrieved {all_conversations_fetched} total conversations in {iteration + 1} request(s), "
                f"{len(filtered_conversations)} after filtering (min_duration={min_duration_secs}s, "
                f"requested {page_size}, returning {len(filtered_conversations)}"
            )

            return filtered_conversations, final_next_cursor

        except httpx.HTTPStatusError as e:
            logger.error(f"HTTP error fetching conversations: {e.response.status_code} - {e.response.text}")
            raise ValueError(f"Failed to fetch conversations: {e.response.status_code}")
        except Exception as e:
            logger.error(f"Error fetching conversations: {str(e)}", exc_info=True)
            raise

    async def get_conversation_details(self, conversation_id: str) -> Dict[str, Any]:
        """
        Get detailed information about a specific conversation.

        Args:
            conversation_id: The conversation ID

        Returns:
            Dictionary containing conversation details including transcript
        """
        try:
            # Check cache first
            cache_key = f"details:{conversation_id}"
            cached = await self.redis.get_json(cache_key)
            if cached:
                logger.info(f"Returning cached conversation details for {conversation_id}")
                return cached

            headers = {
                "xi-api-key": self.api_key,
                "Content-Type": "application/json"
            }

            url = f"{self.base_url}/{conversation_id}"
            logger.info(f"Fetching conversation details for {conversation_id}")

            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.get(url, headers=headers)

                if response.status_code == 404:
                    raise ValueError(f"Conversation {conversation_id} not found")

                if response.status_code == 429:
                    logger.error("ElevenLabs API rate limit exceeded")
                    raise ValueError("Rate limit exceeded. Please try again later.")

                response.raise_for_status()
                conversation_data = response.json()

            # Format the transcript for easier consumption
            transcript = conversation_data.get("transcript", [])
            formatted_transcript = self.format_transcript_for_display(transcript)
            conversation_data["formatted_transcript"] = formatted_transcript

            # Cache for 1 hour
            await self.redis.set_json(cache_key, conversation_data, ttl=3600)

            logger.info(f"Successfully fetched conversation details for {conversation_id}")
            return conversation_data

        except httpx.HTTPStatusError as e:
            logger.error(f"HTTP error fetching conversation details: {e.response.status_code} - {e.response.text}")
            raise ValueError(f"Failed to fetch conversation: {e.response.status_code}")
        except Exception as e:
            logger.error(f"Error fetching conversation details: {str(e)}", exc_info=True)
            raise

    def format_transcript_for_display(self, transcript: List[Dict[str, Any]]) -> str:
        """
        Format transcript array into readable text.

        Args:
            transcript: List of transcript segments

        Returns:
            Formatted transcript string
        """
        if not transcript:
            return "No transcript available"

        formatted_lines = []
        for segment in transcript:
            role = segment.get("role", "unknown")
            message = segment.get("message", "")

            # Map role to readable label
            label = "Agent" if role == "agent" else "Candidate"

            formatted_lines.append(f"{label}: {message}")

        return "\n\n".join(formatted_lines)

    def format_transcript_for_analysis(self, transcript: List[Dict[str, Any]]) -> str:
        """
        Format transcript for AI analysis (plain text with clear speaker labels).

        Args:
            transcript: List of transcript segments

        Returns:
            Formatted transcript for AI processing
        """
        if not transcript:
            return "No transcript available"

        formatted_lines = []
        formatted_lines.append("=== INTERVIEW TRANSCRIPT ===\n")

        for idx, segment in enumerate(transcript, 1):
            role = segment.get("role", "unknown")
            message = segment.get("message", "")

            # Map role to readable label
            label = "INTERVIEWER" if role == "agent" else "CANDIDATE"

            formatted_lines.append(f"[{idx}] {label}: {message}")

        formatted_lines.append("\n=== END OF TRANSCRIPT ===")

        return "\n\n".join(formatted_lines)


# Singleton instance
_conversations_service: Optional[ConversationsService] = None


def get_conversations_service() -> ConversationsService:
    """Get or create Conversations Service singleton."""
    global _conversations_service
    if _conversations_service is None:
        _conversations_service = ConversationsService()
    return _conversations_service
