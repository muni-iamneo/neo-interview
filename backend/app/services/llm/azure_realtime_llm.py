"""
Azure OpenAI real-time LLM service for conversational AI.

Adapts the existing Azure OpenAI integration for streaming real-time responses.
"""

import asyncio
import time
from typing import Optional, Dict, List, AsyncIterator

from app.core.config import get_settings
from app.core.logging_config import get_logger
from app.services.voice_providers.base import BaseLLMProvider
from app.services.agents_service import DEFAULT_GENERIC_SYSTEM_PROMPT

settings = get_settings()
logger = get_logger(__name__)


class AzureRealtimeLLMService(BaseLLMProvider):
    """
    Azure OpenAI LLM service with streaming support.

    Uses the existing Azure OpenAI configuration (GPT-4o-mini) for
    real-time conversational responses.
    """

    def __init__(self, system_prompt: Optional[str] = None):
        self.client = None
        self.system_prompt = system_prompt or DEFAULT_GENERIC_SYSTEM_PROMPT
        self.is_initialized = False
        self.conversation_history: List[Dict[str, str]] = []
        self.max_history_tokens = 2000  # Approximate token limit for context

        # Performance metrics
        self._total_requests = 0
        self._total_duration = 0.0

    async def initialize(self) -> bool:
        """
        Initialize Azure OpenAI client.

        Returns:
            bool: True if initialization successful.
        """
        try:
            # Import Azure OpenAI client
            from openai import AsyncAzureOpenAI

            # Validate configuration
            if not settings.AZURE_ENDPOINT:
                logger.error("[Azure LLM] AZURE_ENDPOINT not configured")
                return False

            if not settings.AZURE_OPENAI_API_KEY:
                logger.error("[Azure LLM] AZURE_OPENAI_API_KEY not configured")
                return False

            logger.info(
                "[Azure LLM] Initializing client: endpoint=%s, model=%s",
                settings.AZURE_ENDPOINT,
                settings.AZURE_OPENAI_DEPLOYMENT,
            )

            # Create async client
            self.client = AsyncAzureOpenAI(
                api_key=settings.AZURE_OPENAI_API_KEY,
                api_version=settings.OPENAI_API_VERSION,
                azure_endpoint=settings.AZURE_ENDPOINT,
            )

            self.is_initialized = True
            logger.info("[Azure LLM] Client initialized successfully")
            return True

        except Exception as e:
            logger.error("[Azure LLM] Failed to initialize: %s", e)
            self.is_initialized = False
            return False

    async def generate_response(
        self,
        user_message: str,
        conversation_history: Optional[List[Dict[str, str]]] = None,
        system_prompt: Optional[str] = None,
    ) -> str:
        """
        Generate a complete response (non-streaming).

        Args:
            user_message: The user's input text.
            conversation_history: Previous conversation messages.
            system_prompt: Optional system prompt override.

        Returns:
            str: Complete LLM response.
        """
        if not self.is_initialized or not self.client:
            logger.error("[Azure LLM] Not initialized")
            return ""

        try:
            start_time = time.time()

            # Build messages
            messages = self._build_messages(
                user_message,
                conversation_history or self.conversation_history,
                system_prompt or self.system_prompt,
            )

            # Call Azure OpenAI (non-streaming)
            response = await self.client.chat.completions.create(
                model=settings.AZURE_OPENAI_DEPLOYMENT,
                messages=messages,
                temperature=settings.AZURE_OPENAI_TEMPERATURE,
                max_tokens=settings.AZURE_OPENAI_MAX_TOKENS,
                stream=False,
            )

            # Extract response
            assistant_message = response.choices[0].message.content or ""

            # Update conversation history
            self._update_history(user_message, assistant_message)

            # Metrics
            duration = time.time() - start_time
            self._total_requests += 1
            self._total_duration += duration

            logger.info(
                "[Azure LLM] Generated response in %.2fms: '%s...'",
                duration * 1000,
                assistant_message[:50],
            )

            return assistant_message

        except Exception as e:
            logger.error("[Azure LLM] Generate failed: %s", e)
            return ""

    async def generate_response_streaming(
        self,
        user_message: str,
        conversation_history: Optional[List[Dict[str, str]]] = None,
        system_prompt: Optional[str] = None,
    ) -> AsyncIterator[str]:
        """
        Generate a streaming response.

        Args:
            user_message: The user's input text.
            conversation_history: Previous conversation messages.
            system_prompt: Optional system prompt override.

        Yields:
            str: Chunks of the LLM response.
        """
        if not self.is_initialized or not self.client:
            logger.error("[Azure LLM] Not initialized")
            return

        try:
            start_time = time.time()
            first_token_time = None
            full_response = []

            # Build messages
            messages = self._build_messages(
                user_message,
                conversation_history or self.conversation_history,
                system_prompt or self.system_prompt,
            )

            # Call Azure OpenAI (streaming)
            # OPTIMIZED: Added presence/frequency penalties for faster, more concise responses
            stream = await self.client.chat.completions.create(
                model=settings.AZURE_OPENAI_DEPLOYMENT,
                messages=messages,
                temperature=settings.AZURE_OPENAI_TEMPERATURE,
                max_tokens=settings.AZURE_OPENAI_MAX_TOKENS,
                stream=True,
                presence_penalty=0.6,  # Encourages concise responses (reduces latency)
                frequency_penalty=0.3,  # Reduces repetition
            )

            # Stream chunks
            async for chunk in stream:
                if not chunk.choices:
                    continue

                delta = chunk.choices[0].delta
                if not delta or not delta.content:
                    continue

                content = delta.content

                # Track first token latency
                if first_token_time is None:
                    first_token_time = time.time()
                    logger.info(
                        "[Azure LLM] First token in %.2fms",
                        (first_token_time - start_time) * 1000,
                    )

                full_response.append(content)
                yield content

            # Update conversation history with complete response
            complete_response = "".join(full_response)
            self._update_history(user_message, complete_response)

            # Metrics
            duration = time.time() - start_time
            self._total_requests += 1
            self._total_duration += duration

            logger.info(
                "[Azure LLM] Streamed response in %.2fms: '%s...'",
                duration * 1000,
                complete_response[:50],
            )

        except Exception as e:
            logger.error("[Azure LLM] Streaming failed: %s", e)

    async def cleanup(self) -> None:
        """Clean up resources."""
        self.conversation_history.clear()
        self.client = None
        self.is_initialized = False

        if self._total_requests > 0:
            avg_duration = (self._total_duration / self._total_requests) * 1000
            logger.info(
                "[Azure LLM] Cleanup: %d requests, avg %.2fms",
                self._total_requests,
                avg_duration,
            )

    def _build_messages(
        self,
        user_message: str,
        conversation_history: List[Dict[str, str]],
        system_prompt: str,
    ) -> List[Dict[str, str]]:
        """
        Build messages array for Azure OpenAI.

        Args:
            user_message: Current user message.
            conversation_history: Previous messages.
            system_prompt: System prompt.

        Returns:
            List of message dicts.
        """
        messages = [{"role": "system", "content": system_prompt}]

        # Add conversation history (limit to prevent token overflow)
        # OPTIMIZED: Reduced from 10 to 3 exchanges for lower latency
        recent_history = conversation_history[-3:]  # Last 3 exchanges (6 messages)
        messages.extend(recent_history)

        # Add current user message
        messages.append({"role": "user", "content": user_message})

        return messages

    def _update_history(self, user_message: str, assistant_message: str):
        """
        Update conversation history.

        Args:
            user_message: User's message.
            assistant_message: Assistant's response.
        """
        self.conversation_history.append({"role": "user", "content": user_message})
        self.conversation_history.append({"role": "assistant", "content": assistant_message})

        # Trim history if too long (rough estimate: ~4 chars per token)
        # OPTIMIZED: Reduced from 20 to 6 messages (3 exchanges) for lower latency
        while len(self.conversation_history) > 6:  # Keep max 3 exchanges
            self.conversation_history.pop(0)

    def get_metrics(self) -> Dict:
        """Get performance metrics."""
        avg_duration = 0.0
        if self._total_requests > 0:
            avg_duration = (self._total_duration / self._total_requests) * 1000

        return {
            "total_requests": self._total_requests,
            "total_duration_ms": self._total_duration * 1000,
            "avg_duration_ms": avg_duration,
            "conversation_history_length": len(self.conversation_history),
        }

    def reset_conversation(self):
        """Reset conversation history."""
        self.conversation_history.clear()
        logger.info("[Azure LLM] Conversation history reset")
