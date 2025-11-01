"""
Interview Analysis Agent using Azure OpenAI.
"""
import json
from typing import Dict, Any, Optional
from autogen_core import CancellationToken
from autogen_core.models import UserMessage, SystemMessage
from autogen_ext.models.openai import AzureOpenAIChatCompletionClient

from ..connections.autogen_client import get_azure_client
from ..core.logging_config import get_logger

logger = get_logger(__name__)


class InterviewAnalysisAgent:
    """AI agent for analyzing interview transcripts and providing hiring recommendations."""

    SYSTEM_MESSAGE = """You are an expert HR interviewer and technical recruiter tasked with analyzing interview transcripts.

Your role is to:
1. Evaluate the candidate's technical knowledge and skills across various subjects
2. Assess communication abilities, problem-solving approach, and overall fit
3. Provide a clear hiring recommendation with supporting reasoning

For each interview transcript, you must analyze:
- Subject-matter expertise (rate as: beginner, intermediate, or expert)
- Key strengths demonstrated during the interview
- Areas of concern or weakness
- Overall hiring recommendation

IMPORTANT: You must respond ONLY with valid JSON in this exact format:
{
  "hiring_recommendation": "hire" | "no-hire" | "consider",
  "subject_knowledge": {
    "Subject Name 1": "expert",
    "Subject Name 2": "intermediate",
    "Subject Name 3": "beginner"
  },
  "reasoning": "Brief 2-3 sentence explanation of your recommendation",
  "strengths": [
    "Specific strength 1",
    "Specific strength 2",
    "Specific strength 3"
  ],
  "concerns": [
    "Specific concern 1",
    "Specific concern 2"
  ]
}

Guidelines:
- hiring_recommendation: Use "hire" for strong candidates, "no-hire" for clear rejects, "consider" for borderline cases
- subject_knowledge: Include 3-5 key technical or skill areas discussed in the interview
- reasoning: Be concise but specific about why you made this recommendation
- strengths: List 2-4 notable positive points
- concerns: List 1-3 areas of weakness or red flags (empty array if none)
- Ensure the JSON is valid and properly formatted
- Do not include any text outside the JSON structure"""

    def __init__(self):
        self.azure_connection = get_azure_client()
        self.client: AzureOpenAIChatCompletionClient = self.azure_connection.get_client()
        logger.info("Interview Analysis Agent initialized")

    async def analyze_transcript(self, transcript: str) -> Dict[str, Any]:
        """
        Analyze an interview transcript and provide structured feedback.

        Args:
            transcript: The formatted interview transcript text

        Returns:
            Dictionary containing analysis results with hiring recommendation,
            subject knowledge ratings, reasoning, strengths, and concerns
        """
        try:
            # Prepare messages using autogen_core message types
            messages = [
                SystemMessage(content=self.SYSTEM_MESSAGE),
                UserMessage(content=f"Analyze this interview transcript:\n\n{transcript}", source="user")
            ]

            logger.info("Sending interview transcript to Azure OpenAI for analysis")

            # Create completion request
            response = await self.client.create(
                messages=messages,
                cancellation_token=CancellationToken()
            )

            # Extract the response content
            if hasattr(response, 'content'):
                response_text = response.content
            elif hasattr(response, 'choices') and len(response.choices) > 0:
                response_text = response.choices[0].message.content
            else:
                raise ValueError("Unexpected response format from Azure OpenAI")

            logger.debug(f"Received response from Azure OpenAI: {response_text[:200]}...")

            # Parse JSON response
            try:
                analysis_result = json.loads(response_text)
            except json.JSONDecodeError as e:
                logger.error(f"Failed to parse JSON response: {e}")
                logger.error(f"Response text: {response_text}")
                # Try to extract JSON from response if it's embedded in text
                import re
                json_match = re.search(r'\{[\s\S]*\}', response_text)
                if json_match:
                    analysis_result = json.loads(json_match.group(0))
                else:
                    raise ValueError("Could not extract valid JSON from response")

            # Validate required fields
            required_fields = ["hiring_recommendation", "subject_knowledge", "reasoning", "strengths", "concerns"]
            for field in required_fields:
                if field not in analysis_result:
                    raise ValueError(f"Missing required field in analysis: {field}")

            # Validate hiring_recommendation value
            valid_recommendations = ["hire", "no-hire", "consider"]
            if analysis_result["hiring_recommendation"] not in valid_recommendations:
                raise ValueError(f"Invalid hiring_recommendation: {analysis_result['hiring_recommendation']}")

            logger.info(f"Successfully analyzed transcript - Recommendation: {analysis_result['hiring_recommendation']}")
            return analysis_result

        except Exception as e:
            logger.error(f"Error analyzing transcript: {str(e)}", exc_info=True)
            raise


# Singleton instance
_interview_agent: Optional[InterviewAnalysisAgent] = None


def get_interview_agent() -> InterviewAnalysisAgent:
    """Get or create Interview Analysis Agent singleton."""
    global _interview_agent
    if _interview_agent is None:
        _interview_agent = InterviewAnalysisAgent()
    return _interview_agent
