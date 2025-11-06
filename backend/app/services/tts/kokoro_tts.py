"""
Kokoro TTS service using Resemble AI's Kokoro-82M.

Provides fast CPU-based text-to-speech synthesis with streaming capabilities.
Achieves 3-11x real-time factor on CPU (40-70ms latency per sentence).
"""

import asyncio
import time
from typing import Optional, AsyncIterator
import numpy as np
import torch

from app.core.config import get_settings
from app.core.logging_config import get_logger
from app.services.voice_providers.base import BaseTTSProvider

settings = get_settings()
logger = get_logger(__name__)


class KokoroTTSService(BaseTTSProvider):
    """
    Kokoro TTS implementation.

    Uses Resemble AI's Kokoro-82M for ultra-low latency text-to-speech.
    Supports sentence-based streaming for reduced latency.
    """

    def __init__(self):
        self.pipeline = None
        self.sample_rate = 24000  # Kokoro uses 24kHz
        self.is_initialized = False

        # Performance metrics
        self._total_syntheses = 0
        self._total_duration = 0.0
        self._total_characters = 0

    async def initialize(self) -> bool:
        """
        Initialize Kokoro TTS pipeline.

        Returns:
            bool: True if initialization successful.
        """
        try:
            # Check if model was preloaded during startup
            from app.services.model_preloader import get_preloader_service
            preloader = get_preloader_service()
            preloaded_pipeline = preloader.get_kokoro_pipeline()

            if preloaded_pipeline is not None:
                logger.info("[Kokoro TTS] Using preloaded pipeline")
                self.pipeline = preloaded_pipeline
            else:
                # Import here to avoid loading if not needed
                from kokoro import KPipeline

                # Determine device
                device = settings.KOKORO_DEVICE
                if device == "auto":
                    try:
                        device = "cuda" if torch.cuda.is_available() else "cpu"
                    except Exception:
                        device = "cpu"

                logger.info("[Kokoro TTS] Initializing pipeline: device=%s", device)

                # Load pipeline
                self.pipeline = KPipeline(
                    lang_code=settings.KOKORO_LANG_CODE,
                    repo_id=settings.KOKORO_REPO_ID,
                    device=device
                )

            logger.info(
                "[Kokoro TTS] Pipeline loaded: sample_rate=%d Hz",
                self.sample_rate,
            )

            self.is_initialized = True
            logger.info("[Kokoro TTS] Initialized successfully")
            return True

        except Exception as e:
            logger.error("[Kokoro TTS] Failed to initialize: %s", e)
            self.is_initialized = False
            return False

    async def synthesize(self, text: str) -> bytes:
        """
        Synthesize text to speech (complete generation).

        Args:
            text: Text to synthesize.

        Returns:
            bytes: PCM16 audio @ 16kHz.
        """
        if not self.is_initialized or not self.pipeline:
            logger.error("[Kokoro TTS] Not initialized")
            return b""

        if not text or not text.strip():
            return b""

        try:
            start_time = time.time()

            # Run synthesis in thread pool
            loop = asyncio.get_event_loop()
            audio = await loop.run_in_executor(
                None,
                self._synthesize_sync,
                text,
            )

            # Convert to PCM16 @ 16kHz
            pcm16 = await self._convert_to_pcm16(audio, self.sample_rate)

            # Metrics
            duration = time.time() - start_time
            self._total_syntheses += 1
            self._total_duration += duration
            self._total_characters += len(text)

            logger.info(
                "[Kokoro TTS] Synthesized in %.2fms: '%s...' (%d bytes)",
                duration * 1000,
                text[:50],
                len(pcm16),
            )

            return pcm16

        except Exception as e:
            logger.error("[Kokoro TTS] Synthesis failed: %s", e)
            return b""

    async def synthesize_streaming(self, text: str) -> AsyncIterator[bytes]:
        """
        Synthesize text with sentence-based streaming.

        Kokoro generates audio per phoneme/token, we collect and stream
        complete results for each sentence.

        Args:
            text: Text to synthesize.

        Yields:
            bytes: PCM16 audio chunks @ 16kHz.
        """
        if not self.is_initialized or not text or not text.strip():
            return

        # Import sentence splitter
        from app.services.utils.text_utils import split_into_sentences

        # Split text into sentences
        sentences = split_into_sentences(text)

        logger.info(
            "[Kokoro TTS] Streaming %d sentences: '%s...'",
            len(sentences),
            text[:100],
        )

        # Generate audio for each sentence
        for i, sentence in enumerate(sentences):
            if not sentence.strip():
                continue

            try:
                # Synthesize sentence
                pcm16 = await self.synthesize(sentence)
                if pcm16:
                    logger.debug(
                        "[Kokoro TTS] Sentence %d/%d: %d bytes",
                        i + 1,
                        len(sentences),
                        len(pcm16),
                    )
                    yield pcm16

            except Exception as e:
                logger.error(
                    "[Kokoro TTS] Failed to synthesize sentence %d: %s",
                    i + 1,
                    e,
                )
                continue

    def _synthesize_sync(self, text: str) -> np.ndarray:
        """
        Synchronous synthesis (runs in thread pool).

        Args:
            text: Text to synthesize.

        Returns:
            np.ndarray: Audio waveform from Kokoro (24kHz float32).
        """
        voice = settings.KOKORO_VOICE

        # Generate audio using Kokoro pipeline
        # Pipeline returns a generator of Result objects
        audio_tensors = []
        for result in self.pipeline(text, voice=voice):
            # Each result has .audio tensor
            audio_tensors.append(result.audio.cpu())

        # Concatenate all chunks
        audio_tensor = torch.cat(audio_tensors)
        audio = audio_tensor.numpy()

        return audio

    async def _convert_to_pcm16(self, audio: np.ndarray, source_sample_rate: int) -> bytes:
        """
        Convert Kokoro output to PCM16 @ 16kHz.

        Args:
            audio: Float32 waveform from Kokoro.
            source_sample_rate: Original sample rate (24kHz).

        Returns:
            bytes: PCM16 audio @ 16kHz.
        """
        try:
            # Resample to 16kHz if needed
            target_sample_rate = settings.AUDIO_SAMPLE_RATE
            if source_sample_rate != target_sample_rate:
                # Run resampling in thread pool
                loop = asyncio.get_event_loop()
                audio = await loop.run_in_executor(
                    None,
                    self._resample_audio,
                    audio,
                    source_sample_rate,
                    target_sample_rate,
                )

            # Normalize to [-1, 1] range
            if audio.dtype == np.float32 or audio.dtype == np.float64:
                max_val = np.abs(audio).max()
                if max_val > 0:
                    audio = audio / max_val

            # Convert to PCM16
            pcm16_np = (audio * 32767).astype(np.int16)
            pcm16_bytes = pcm16_np.tobytes()

            return pcm16_bytes

        except Exception as e:
            logger.error("[Kokoro TTS] Audio conversion failed: %s", e)
            return b""

    def _resample_audio(
        self,
        audio: np.ndarray,
        orig_sr: int,
        target_sr: int,
    ) -> np.ndarray:
        """
        Resample audio using scipy.

        Args:
            audio: Audio array.
            orig_sr: Original sample rate.
            target_sr: Target sample rate.

        Returns:
            Resampled audio array.
        """
        from scipy import signal

        # Calculate resampling ratio
        num_samples = int(len(audio) * target_sr / orig_sr)

        # Resample
        resampled = signal.resample(audio, num_samples)

        return resampled

    async def cleanup(self) -> None:
        """Clean up resources."""
        self.pipeline = None
        self.is_initialized = False

        if self._total_syntheses > 0:
            avg_duration = (self._total_duration / self._total_syntheses) * 1000
            avg_chars = self._total_characters / self._total_syntheses
            logger.info(
                "[Kokoro TTS] Cleanup: %d syntheses, avg %.2fms, avg %.1f chars",
                self._total_syntheses,
                avg_duration,
                avg_chars,
            )

    def get_metrics(self) -> dict:
        """Get performance metrics."""
        avg_duration = 0.0
        avg_chars = 0.0

        if self._total_syntheses > 0:
            avg_duration = (self._total_duration / self._total_syntheses) * 1000
            avg_chars = self._total_characters / self._total_syntheses

        return {
            "total_syntheses": self._total_syntheses,
            "total_duration_ms": self._total_duration * 1000,
            "avg_duration_ms": avg_duration,
            "total_characters": self._total_characters,
            "avg_characters": avg_chars,
        }
