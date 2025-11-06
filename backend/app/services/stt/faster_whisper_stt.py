"""
Faster-Whisper STT service for local, ultra-low latency speech recognition.

Uses the faster-whisper library for CPU-optimized real-time transcription.
This is the primary STT provider for the custom voice pipeline.

Architecture:
1. Buffer audio locally (50ms chunks)
2. Detect silence using VAD
3. When speech detected, process audio with Faster-Whisper
4. Send final transcripts via callback

Performance:
- Typical latency: 800-1200ms with distil-medium (local processing, no API calls, no cloud costs)
- Model size: ~200MB (distil-medium) to ~1.4GB (large)
- CPU only (no GPU needed)
- Accuracy: ~97-98% WER with distil-medium (vs ~95% for small.en, ~92% for tiny.en)
"""

import asyncio
import logging
from typing import Callable, Optional
import numpy as np
from faster_whisper import WhisperModel

logger = logging.getLogger(__name__)


class FasterWhisperSTTService:
    """
    Faster-Whisper STT implementation for local, real-time transcription.
    """

    def __init__(self, on_transcript: Callable[[str], None]):
        """
        Initialize Faster-Whisper STT service.

        Args:
            on_transcript: Callback function called when transcript received.
        """
        self.on_transcript = on_transcript
        self.sample_rate = 16000
        self.model = None
        self.is_initialized = False

        # Audio buffering
        self.audio_buffer = bytearray()
        self.min_audio_length_bytes = int(self.sample_rate * 2 * 0.5)  # 0.5 seconds minimum

        # Simple energy-based VAD
        self.is_recording = False
        self.silence_chunks = 0
        self.silence_threshold_chunks = 30  # ~960ms at 32ms chunks (faster speech detection)
        self.energy_threshold = 30  # RMS energy threshold (lowered for better sensitivity)

        # State
        self._last_sent_transcript = ""
        self._transcription_count = 0
        self._processing = False

        logger.info("[Faster-Whisper STT] Initialized")

    async def initialize(self) -> bool:
        """
        Initialize the Faster-Whisper model.

        Returns:
            bool: True if initialization successful.
        """
        try:
            logger.info("[Faster-Whisper STT] Loading Whisper model (distil-medium)...")

            # Use distil-medium model for better accuracy with moderate latency
            # Options: tiny (~39M), base (~74M), small (~244M), distil-medium (~400M), medium (~769M), large (~1.5B)
            # distil-medium: ~400M params, ~97-98% WER accuracy, optimized for speed vs medium
            self.model = WhisperModel("distil-medium.en", device="cpu", compute_type="int8")

            self.is_initialized = True
            logger.info("[Faster-Whisper STT] Model loaded successfully")
            return True

        except Exception as e:
            logger.error(f"[Faster-Whisper STT] Initialization failed: {e}")
            return False

    async def process_audio(self, audio_chunk: bytes) -> None:
        """
        Buffer audio and detect silence using energy-based VAD.
        When silence detected, transcribe with Faster-Whisper.

        This is the main method called by the voice endpoint.
        """
        await self.send_audio(audio_chunk)

    async def send_audio(self, audio_chunk: bytes) -> None:
        """
        Buffer audio and detect silence using energy-based VAD.
        When silence detected, transcribe with Faster-Whisper.
        """
        if not self.is_initialized or self._processing:
            return

        # Add to buffer
        self.audio_buffer.extend(audio_chunk)

        # Calculate energy (RMS) of this chunk
        try:
            if not audio_chunk or len(audio_chunk) == 0:
                is_speech = False
            else:
                audio_array = np.frombuffer(audio_chunk, dtype=np.int16).astype(np.float64)
                mean_sq = np.mean(audio_array**2)
                # Guard against NaN values (shouldn't happen, but handle gracefully)
                if np.isnan(mean_sq) or mean_sq < 0:
                    is_speech = False
                else:
                    rms = np.sqrt(mean_sq)
                    is_speech = rms > self.energy_threshold
        except Exception as e:
            logger.debug(f"[Faster-Whisper STT] Energy calculation error: {e}")
            is_speech = False  # Assume no speech if calculation fails

        if is_speech:
            self.silence_chunks = 0
            if not self.is_recording:
                self.is_recording = True
                logger.info("[Faster-Whisper STT] Speech detected, recording...")
        else:
            if self.is_recording:
                self.silence_chunks += 1

                # Check if enough silence to end recording
                if self.silence_chunks >= self.silence_threshold_chunks:
                    if len(self.audio_buffer) >= self.min_audio_length_bytes:
                        duration = len(self.audio_buffer) / (self.sample_rate * 2)
                        logger.info(
                            "[Faster-Whisper STT] Silence detected (%.1fs), transcribing %.1fs of audio...",
                            self.silence_chunks * 0.032,
                            duration
                        )
                        # Transcribe (non-blocking)
                        asyncio.create_task(self._transcribe_audio(bytes(self.audio_buffer)))

                    # Reset
                    self.audio_buffer.clear()
                    self.is_recording = False
                    self.silence_chunks = 0

    async def _transcribe_audio(self, audio_data: bytes) -> None:
        """
        Transcribe audio using Faster-Whisper.
        """
        if not self.model or self._processing:
            return

        self._processing = True
        start_time = asyncio.get_event_loop().time()

        try:
            # Convert bytes to numpy array
            audio_array = np.frombuffer(audio_data, dtype=np.int16).astype(np.float32) / 32768.0

            logger.info(
                "[Faster-Whisper STT] Starting transcription (%.1fs of audio)...",
                len(audio_data) / (self.sample_rate * 2)
            )

            # Run transcription in executor to avoid blocking
            segments, info = await asyncio.get_event_loop().run_in_executor(
                None,
                self.model.transcribe,
                audio_array,
            )

            # Combine segments into full transcript
            transcript_text = " ".join([segment.text for segment in segments]).strip()

            elapsed = asyncio.get_event_loop().time() - start_time
            logger.info(
                "[Faster-Whisper STT] Transcription complete (%.0fms): '%s'",
                elapsed * 1000,
                transcript_text[:100]
            )

            # Check for duplicate
            normalized_text = transcript_text.lower().strip()
            normalized_last = self._last_sent_transcript.lower().strip()
            is_duplicate = normalized_text == normalized_last

            if transcript_text and not is_duplicate:
                self._last_sent_transcript = transcript_text
                self._transcription_count += 1
                await self._safe_callback(transcript_text)
            elif is_duplicate:
                logger.debug("[Faster-Whisper STT] Skipping duplicate transcript")
            else:
                logger.debug("[Faster-Whisper STT] Empty transcript, skipping")

        except Exception as e:
            logger.error(f"[Faster-Whisper STT] Transcription failed: {e}", exc_info=True)
        finally:
            self._processing = False

    async def _safe_callback(self, text: str) -> None:
        """Safely call the transcript callback."""
        try:
            if asyncio.iscoroutinefunction(self.on_transcript):
                await self.on_transcript(text)
            else:
                self.on_transcript(text)
        except Exception as e:
            logger.error(f"[Faster-Whisper STT] Callback error: {e}", exc_info=True)

    def get_metrics(self) -> dict:
        """Get STT metrics."""
        return {
            "transcriptions": self._transcription_count,
        }

    async def cleanup(self) -> None:
        """Clean up resources (alias for close)."""
        await self.close()

    async def close(self) -> None:
        """Clean up resources."""
        # Process any remaining audio
        if len(self.audio_buffer) >= self.min_audio_length_bytes:
            duration = len(self.audio_buffer) / (self.sample_rate * 2)
            logger.info(
                "[Faster-Whisper STT] Processing remaining %.1fs of audio...",
                duration
            )
            await self._transcribe_audio(bytes(self.audio_buffer))

        self.audio_buffer.clear()
        self.is_initialized = False

        logger.info(
            "[Faster-Whisper STT] Closed (processed %d transcriptions)",
            self._transcription_count
        )
