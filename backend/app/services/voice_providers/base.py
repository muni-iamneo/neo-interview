"""
Base interfaces for voice AI providers.

Defines abstract base classes for STT, LLM, TTS, and complete voice providers,
enabling pluggable implementations (ElevenLabs, custom pipeline, etc.).
"""

from abc import ABC, abstractmethod
from typing import Callable, Optional, Dict, Any
from dataclasses import dataclass


@dataclass
class VoiceProviderCallback:
    """Callbacks for voice provider events."""

    on_audio_response: Optional[Callable[[bytes], None]] = None
    """Called when audio chunk is received (PCM16 @ 16kHz)."""

    on_text_response: Optional[Callable[[str], None]] = None
    """Called when text transcript is received."""

    on_conversation_end: Optional[Callable[[], None]] = None
    """Called when conversation ends."""

    on_error: Optional[Callable[[Exception], None]] = None
    """Called when an error occurs."""

    on_latency_metric: Optional[Callable[[str, float], None]] = None
    """Called with latency metrics (metric_name, duration_ms)."""


class BaseSTTProvider(ABC):
    """Abstract base class for Speech-to-Text providers."""

    @abstractmethod
    async def initialize(self) -> bool:
        """
        Initialize the STT provider.

        Returns:
            bool: True if initialization successful.
        """
        pass

    @abstractmethod
    async def process_audio(self, pcm16: bytes) -> Optional[str]:
        """
        Process audio chunk and return transcription if available.

        Args:
            pcm16: Raw PCM16 audio bytes @ 16kHz.

        Returns:
            Optional[str]: Transcribed text if speech detected, None otherwise.
        """
        pass

    @abstractmethod
    async def flush(self) -> Optional[str]:
        """
        Flush any buffered audio and return final transcription.

        Returns:
            Optional[str]: Final transcribed text.
        """
        pass

    @abstractmethod
    async def cleanup(self) -> None:
        """Clean up resources."""
        pass


class BaseLLMProvider(ABC):
    """Abstract base class for Language Model providers."""

    @abstractmethod
    async def initialize(self) -> bool:
        """
        Initialize the LLM provider.

        Returns:
            bool: True if initialization successful.
        """
        pass

    @abstractmethod
    async def generate_response(
        self,
        user_message: str,
        conversation_history: Optional[list[Dict[str, str]]] = None,
        system_prompt: Optional[str] = None,
    ) -> str:
        """
        Generate a response to user message (non-streaming).

        Args:
            user_message: The user's input text.
            conversation_history: Previous conversation messages.
            system_prompt: Optional system prompt override.

        Returns:
            str: Complete LLM response.
        """
        pass

    @abstractmethod
    async def generate_response_streaming(
        self,
        user_message: str,
        conversation_history: Optional[list[Dict[str, str]]] = None,
        system_prompt: Optional[str] = None,
    ):
        """
        Generate a streaming response to user message.

        Args:
            user_message: The user's input text.
            conversation_history: Previous conversation messages.
            system_prompt: Optional system prompt override.

        Yields:
            str: Chunks of the LLM response.
        """
        pass

    @abstractmethod
    async def cleanup(self) -> None:
        """Clean up resources."""
        pass


class BaseTTSProvider(ABC):
    """Abstract base class for Text-to-Speech providers."""

    @abstractmethod
    async def initialize(self) -> bool:
        """
        Initialize the TTS provider.

        Returns:
            bool: True if initialization successful.
        """
        pass

    @abstractmethod
    async def synthesize(self, text: str) -> bytes:
        """
        Synthesize text to speech (complete generation).

        Args:
            text: Text to synthesize.

        Returns:
            bytes: PCM16 audio @ 16kHz.
        """
        pass

    @abstractmethod
    async def synthesize_streaming(self, text: str):
        """
        Synthesize text to speech with streaming output.

        Args:
            text: Text to synthesize.

        Yields:
            bytes: PCM16 audio chunks @ 16kHz.
        """
        pass

    @abstractmethod
    async def cleanup(self) -> None:
        """Clean up resources."""
        pass


class BaseVoiceProvider(ABC):
    """
    Abstract base class for complete voice AI providers.

    Handles the full pipeline: user audio → STT → LLM → TTS → agent audio.
    Implementations can be end-to-end (ElevenLabs) or composed (custom pipeline).
    """

    def __init__(self, callbacks: VoiceProviderCallback):
        """
        Initialize the voice provider.

        Args:
            callbacks: Callback functions for provider events.
        """
        self.callbacks = callbacks

    @abstractmethod
    async def initialize(self, agent_id: str, **kwargs) -> bool:
        """
        Initialize the voice provider with configuration.

        Args:
            agent_id: Unique identifier for the agent/conversation.
            **kwargs: Provider-specific configuration.

        Returns:
            bool: True if initialization successful.
        """
        pass

    @abstractmethod
    async def process_audio_chunk(self, pcm16: bytes) -> None:
        """
        Process incoming user audio chunk.

        Audio should be PCM16 format @ 16kHz. Provider is responsible for
        buffering, processing, and triggering callbacks.

        Args:
            pcm16: Raw PCM16 audio bytes.
        """
        pass

    @abstractmethod
    async def send_text_message(self, text: str) -> None:
        """
        Send a text message to the provider (if supported).

        Args:
            text: Text message to send.
        """
        pass

    @abstractmethod
    async def interrupt(self) -> None:
        """
        Interrupt current agent response (if supported).
        """
        pass

    @abstractmethod
    async def cleanup(self) -> None:
        """
        Clean up resources and close connections.
        """
        pass

    @abstractmethod
    def is_ready(self) -> bool:
        """
        Check if provider is ready to process audio.

        Returns:
            bool: True if ready.
        """
        pass

    def get_metrics(self) -> Dict[str, Any]:
        """
        Get provider performance metrics.

        Returns:
            Dict[str, Any]: Metrics dictionary (latency, token counts, etc.).
        """
        return {}
