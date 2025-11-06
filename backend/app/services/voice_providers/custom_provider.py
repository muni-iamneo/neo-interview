"""
Custom voice pipeline provider.

Orchestrates STT (AssemblyAI) → LLM (Azure OpenAI) → TTS (Kokoro)
for a complete voice AI solution with ultra-low latency.
"""

import asyncio
import time
from typing import Dict, Any, Optional

from app.core.config import get_settings
from app.core.logging_config import get_logger
from app.services.voice_providers.base import BaseVoiceProvider, VoiceProviderCallback
from app.services.stt import get_stt_service
from app.services.llm.azure_realtime_llm import AzureRealtimeLLMService
from app.services.tts.kokoro_tts import KokoroTTSService
from app.services.agents_service import DEFAULT_GENERIC_SYSTEM_PROMPT

settings = get_settings()
logger = get_logger(__name__)


class CustomVoiceProvider(BaseVoiceProvider):
    """
    Custom voice pipeline provider (NEO).

    Implements the complete voice AI pipeline:
    1. User audio (PCM16) → Faster-Whisper STT (local, 200-400ms latency) → Text
    2. Text → Azure OpenAI LLM → Response text (streaming)
    3. Response text → Kokoro TTS (CPU-optimized) → Agent audio (PCM16)

    This is the primary voice provider with ultra-low latency for conversational AI.
    """

    def __init__(self, callbacks: VoiceProviderCallback):
        super().__init__(callbacks)

        # Pipeline components
        self.stt = None  # Will be initialized based on config (Faster-Whisper by default)
        self.llm: Optional[AzureRealtimeLLMService] = None
        self.tts: Optional[KokoroTTSService] = None

        # State management
        self.is_initialized_flag = False
        self.is_processing = False
        self.agent_id: Optional[str] = None

        # Performance metrics
        self.metrics = {
            "stt_latency_ms": [],
            "llm_first_token_ms": [],
            "llm_total_ms": [],
            "tts_latency_ms": [],
            "end_to_end_ms": [],
        }

    async def initialize(self, agent_id: str, **kwargs) -> bool:
        """
        Initialize the custom voice pipeline.

        Args:
            agent_id: Unique identifier for the agent/conversation.
            **kwargs: Additional configuration.

        Returns:
            bool: True if initialization successful.
        """
        try:
            logger.info("[Custom Provider] Initializing pipeline for agent: %s", agent_id)
            self.agent_id = agent_id

            # Initialize STT (Faster-Whisper by default, or AssemblyAI if configured)
            logger.info("[Custom Provider] Loading STT...")
            self.stt = get_stt_service(on_transcript=self._on_stt_transcript)
            if not await self.stt.initialize():
                logger.error("[Custom Provider] STT initialization failed")
                return False

            # Initialize LLM
            logger.info("[Custom Provider] Loading LLM (Azure OpenAI)...")
            base_prompt = kwargs.get("system_prompt", DEFAULT_GENERIC_SYSTEM_PROMPT)

            # Append conversational instructions (like ElevenLabs does)
            conversational_instructions = settings.LLM_CONVERSATIONAL_INSTRUCTIONS
            full_system_prompt = f"{base_prompt}\n\n{conversational_instructions}"

            self.llm = AzureRealtimeLLMService(system_prompt=full_system_prompt)
            if not await self.llm.initialize():
                logger.error("[Custom Provider] LLM initialization failed")
                return False

            # Initialize TTS
            logger.info("[Custom Provider] Loading TTS (Kokoro)...")
            self.tts = KokoroTTSService()
            if not await self.tts.initialize():
                logger.error("[Custom Provider] TTS initialization failed")
                return False

            self.is_initialized_flag = True
            logger.info("[Custom Provider] Pipeline initialized successfully")
            return True

        except Exception as e:
            logger.error("[Custom Provider] Initialization failed: %s", e)
            if self.callbacks.on_error:
                self.callbacks.on_error(e)
            return False

    async def _on_stt_transcript(self, transcription: str):
        """
        Callback for AssemblyAI transcripts.

        Called when AssemblyAI delivers a final transcript.

        Args:
            transcription: Transcribed text from AssemblyAI.
        """
        try:
            if not transcription or not transcription.strip():
                return

            logger.info("[Custom Provider] AssemblyAI transcript: '%s'", transcription)

            # Send text callback
            if self.callbacks.on_text_response:
                await self.callbacks.on_text_response(f"[User] {transcription}")

            # Process through pipeline (non-blocking)
            asyncio.create_task(self._process_pipeline(transcription))

        except Exception as e:
            logger.error("[Custom Provider] Transcript callback error: %s", e)
            if self.callbacks.on_error:
                self.callbacks.on_error(e)

    async def process_audio_chunk(self, pcm16: bytes) -> None:
        """
        Process incoming user audio chunk.

        Streams audio to AssemblyAI WebSocket (transcripts delivered via callback).

        Args:
            pcm16: Raw PCM16 audio bytes @ 16kHz.
        """
        if not self.is_initialized_flag or not self.stt:
            return

        try:
            # Stream audio to AssemblyAI (transcripts come via _on_stt_transcript callback)
            await self.stt.process_audio(pcm16)

        except Exception as e:
            logger.error("[Custom Provider] Audio processing failed: %s", e)
            if self.callbacks.on_error:
                self.callbacks.on_error(e)

    async def _process_pipeline(self, user_message: str):
        """
        Process user message through LLM → TTS pipeline.

        Args:
            user_message: Transcribed user message.
        """
        if self.is_processing:
            logger.warning("[Custom Provider] Already processing, skipping")
            return

        self.is_processing = True
        pipeline_start = time.time()

        try:
            # LLM: Generate response (streaming)
            llm_start = time.time()
            first_token_time = None
            response_chunks = []

            async for chunk in self.llm.generate_response_streaming(user_message):
                # Track first token latency
                if first_token_time is None:
                    first_token_time = time.time()
                    first_token_latency = (first_token_time - llm_start) * 1000
                    self.metrics["llm_first_token_ms"].append(first_token_latency)

                    if self.callbacks.on_latency_metric:
                        await self.callbacks.on_latency_metric("llm_first_token", first_token_latency)

                    logger.info("[Custom Provider] LLM first token: %.2fms", first_token_latency)

                response_chunks.append(chunk)

            # Complete response
            full_response = "".join(response_chunks)
            llm_duration = (time.time() - llm_start) * 1000
            self.metrics["llm_total_ms"].append(llm_duration)

            if self.callbacks.on_latency_metric:
                await self.callbacks.on_latency_metric("llm_total", llm_duration)

            logger.info(
                "[Custom Provider] LLM response (%.2fms): '%s...'",
                llm_duration,
                full_response[:100],
            )

            # Send text callback
            if self.callbacks.on_text_response:
                await self.callbacks.on_text_response(f"[Agent] {full_response}")

            # TTS: Synthesize response (sentence streaming)
            tts_start = time.time()
            first_audio_sent = False

            async for audio_chunk in self.tts.synthesize_streaming(full_response):
                if not first_audio_sent:
                    first_audio_latency = (time.time() - tts_start) * 1000
                    self.metrics["tts_latency_ms"].append(first_audio_latency)

                    if self.callbacks.on_latency_metric:
                        await self.callbacks.on_latency_metric("tts_first_audio", first_audio_latency)

                    logger.info("[Custom Provider] TTS first audio: %.2fms", first_audio_latency)
                    first_audio_sent = True

                # Send audio callback
                if self.callbacks.on_audio_response:
                    await self.callbacks.on_audio_response(audio_chunk)

            # End-to-end metrics
            pipeline_duration = (time.time() - pipeline_start) * 1000
            self.metrics["end_to_end_ms"].append(pipeline_duration)

            if self.callbacks.on_latency_metric:
                await self.callbacks.on_latency_metric("pipeline_end_to_end", pipeline_duration)

            logger.info(
                "[Custom Provider] Pipeline complete: %.2fms (STT→LLM→TTS)",
                pipeline_duration,
            )

        except Exception as e:
            logger.error("[Custom Provider] Pipeline processing failed: %s", e)
            if self.callbacks.on_error:
                self.callbacks.on_error(e)

        finally:
            self.is_processing = False

    async def send_text_message(self, text: str) -> None:
        """
        Send a text message directly (bypassing STT).

        Args:
            text: Text message to send.
        """
        logger.info("[Custom Provider] Text message: '%s'", text)
        asyncio.create_task(self._process_pipeline(text))

    async def interrupt(self) -> None:
        """
        Interrupt current agent response.

        For custom pipeline, this could stop TTS generation.
        """
        logger.info("[Custom Provider] Interrupt requested")
        # Could implement TTS cancellation here
        self.is_processing = False

    async def cleanup(self) -> None:
        """Clean up all pipeline resources."""
        logger.info("[Custom Provider] Cleaning up pipeline")

        if self.stt:
            await self.stt.cleanup()
        if self.llm:
            await self.llm.cleanup()
        if self.tts:
            await self.tts.cleanup()

        self.is_initialized_flag = False
        self._log_metrics()

    def is_ready(self) -> bool:
        """Check if provider is ready."""
        return (
            self.is_initialized_flag
            and self.stt is not None
            and self.llm is not None
            and self.tts is not None
        )

    def get_metrics(self) -> Dict[str, Any]:
        """Get performance metrics."""
        def avg(values):
            return sum(values) / len(values) if values else 0.0

        return {
            "provider": "custom",
            "is_ready": self.is_ready(),
            "total_requests": len(self.metrics["end_to_end_ms"]),
            "avg_stt_latency_ms": avg(self.metrics["stt_latency_ms"]),
            "avg_llm_first_token_ms": avg(self.metrics["llm_first_token_ms"]),
            "avg_llm_total_ms": avg(self.metrics["llm_total_ms"]),
            "avg_tts_latency_ms": avg(self.metrics["tts_latency_ms"]),
            "avg_end_to_end_ms": avg(self.metrics["end_to_end_ms"]),
            "stt_metrics": self.stt.get_metrics() if self.stt else {},
            "llm_metrics": self.llm.get_metrics() if self.llm else {},
            "tts_metrics": self.tts.get_metrics() if self.tts else {},
        }

    def _log_metrics(self):
        """Log performance metrics summary."""
        metrics = self.get_metrics()
        logger.info(
            "[Custom Provider] Metrics Summary:\n"
            "  Total requests: %d\n"
            "  Avg STT latency: %.2fms\n"
            "  Avg LLM first token: %.2fms\n"
            "  Avg LLM total: %.2fms\n"
            "  Avg TTS latency: %.2fms\n"
            "  Avg end-to-end: %.2fms",
            metrics["total_requests"],
            metrics["avg_stt_latency_ms"],
            metrics["avg_llm_first_token_ms"],
            metrics["avg_llm_total_ms"],
            metrics["avg_tts_latency_ms"],
            metrics["avg_end_to_end_ms"],
        )
