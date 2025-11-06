"""
AssemblyAI Standard (Non-Streaming) STT Implementation

WARNING: This implementation has ~1.5-3 second higher latency than streaming API.
Use only for testing/comparison purposes.
"""

import asyncio
import logging
import io
import wave
import time
from typing import Callable, Optional
import numpy as np

from app.core.config import settings

logger = logging.getLogger(__name__)


class AssemblyAIStandardSTTService:
    """
    AssemblyAI Standard API STT implementation (HTTP POST).

    Architecture:
    1. Buffer audio locally
    2. Detect silence using simple energy-based VAD
    3. Upload complete audio file to AssemblyAI
    4. Poll for transcription result
    5. Send final transcript

    Performance:
    - Silence detection: ~1000-1500ms (local VAD)
    - File upload: ~200-500ms (network dependent)
    - Processing: ~500-1000ms (server-side)
    - Total STT latency: ~1700-3000ms

    Compare to Streaming API:
    - Streaming: ~700-800ms STT latency
    - Standard: ~1700-3000ms STT latency
    - Difference: +1000-2200ms slower
    """

    def __init__(self, on_transcript: Callable[[str], None]):
        self.on_transcript = on_transcript
        self.sample_rate = settings.AUDIO_SAMPLE_RATE
        self.api_key = settings.ASSEMBLYAI_API_KEY

        # Audio buffering
        self.audio_buffer = bytearray()
        self.min_audio_length_bytes = int(self.sample_rate * 2 * 0.5)  # 0.5 seconds minimum

        # Simple energy-based VAD
        self.is_recording = False
        self.silence_chunks = 0
        self.silence_threshold_chunks = 45  # ~1.4 seconds at 32ms chunks
        self.energy_threshold = 500  # RMS energy threshold

        # State
        self.is_initialized = False
        self._last_sent_transcript = ""

        # Stats
        self._transcription_count = 0

        logger.info("[AssemblyAI Standard] Initialized (WARNING: High latency mode)")

    async def initialize(self) -> bool:
        """Initialize the service."""
        try:
            # Import here to avoid dependency if not used
            import requests
            self._requests = requests

            if not self.api_key:
                logger.error("[AssemblyAI Standard] No API key configured")
                return False

            # Quick API check
            response = self._requests.get(
                "https://api.assemblyai.com/v2/transcript",
                headers={"authorization": self.api_key},
                timeout=5
            )

            if response.status_code == 401:
                logger.error("[AssemblyAI Standard] Invalid API key")
                return False

            self.is_initialized = True
            logger.info("[AssemblyAI Standard] Initialized successfully")
            logger.warning(
                "[AssemblyAI Standard] Using Standard API: Expect 1.5-3 second higher latency vs Streaming API"
            )
            return True

        except ImportError:
            logger.error("[AssemblyAI Standard] 'requests' library not found. Install: pip install requests")
            return False
        except Exception as e:
            logger.error(f"[AssemblyAI Standard] Initialization failed: {e}")
            return False

    async def send_audio(self, audio_chunk: bytes) -> None:
        """
        Buffer audio and detect silence using energy-based VAD.
        When silence detected, upload and transcribe.
        """
        if not self.is_initialized:
            return

        # Add to buffer
        self.audio_buffer.extend(audio_chunk)

        # Calculate energy (RMS) of this chunk
        try:
            audio_array = np.frombuffer(audio_chunk, dtype=np.int16)
            rms = np.sqrt(np.mean(audio_array**2))
            is_speech = rms > self.energy_threshold
        except Exception as e:
            logger.debug(f"[AssemblyAI Standard] Energy calculation error: {e}")
            is_speech = True  # Assume speech if calculation fails

        if is_speech:
            self.silence_chunks = 0
            if not self.is_recording:
                self.is_recording = True
                logger.info("[AssemblyAI Standard] Speech detected, recording...")
        else:
            if self.is_recording:
                self.silence_chunks += 1

                # Check if enough silence to end recording
                if self.silence_chunks >= self.silence_threshold_chunks:
                    if len(self.audio_buffer) >= self.min_audio_length_bytes:
                        duration = len(self.audio_buffer) / (self.sample_rate * 2)
                        logger.info(
                            "[AssemblyAI Standard] Silence detected (%.1fs), uploading %.1fs of audio...",
                            self.silence_chunks * 0.032,  # ~32ms per chunk
                            duration
                        )
                        # Send for transcription (non-blocking)
                        asyncio.create_task(self._transcribe_audio(bytes(self.audio_buffer)))

                    # Reset
                    self.audio_buffer.clear()
                    self.is_recording = False
                    self.silence_chunks = 0

    async def _transcribe_audio(self, audio_data: bytes) -> None:
        """
        Upload audio to AssemblyAI and poll for transcription.
        This is where the latency comes from.
        """
        start_time = time.time()

        try:
            # Step 1: Create WAV file in memory
            wav_io = io.BytesIO()
            with wave.open(wav_io, 'wb') as wav_file:
                wav_file.setnchannels(1)  # Mono
                wav_file.setsampwidth(2)  # 16-bit
                wav_file.setframerate(self.sample_rate)
                wav_file.writeframes(audio_data)
            wav_data = wav_io.getvalue()

            file_create_time = time.time()
            logger.debug(
                "[AssemblyAI Standard] WAV file created: %.0fms",
                (file_create_time - start_time) * 1000
            )

            # Step 2: Upload audio file
            upload_response = await asyncio.to_thread(
                self._requests.post,
                "https://api.assemblyai.com/v2/upload",
                headers={"authorization": self.api_key},
                data=wav_data,
                timeout=30
            )

            if upload_response.status_code != 200:
                logger.error(
                    "[AssemblyAI Standard] Upload failed (%d): %s",
                    upload_response.status_code,
                    upload_response.text[:200]
                )
                return

            upload_url = upload_response.json()["upload_url"]
            upload_complete_time = time.time()
            logger.info(
                "[AssemblyAI Standard] Upload complete: %.0fms",
                (upload_complete_time - file_create_time) * 1000
            )

            # Step 3: Create transcription job
            transcript_config = {
                "audio_url": upload_url,
            }

            # Add word boost if configured
            if settings.ASSEMBLYAI_WORD_BOOST:
                transcript_config["word_boost"] = settings.ASSEMBLYAI_WORD_BOOST

            transcript_response = await asyncio.to_thread(
                self._requests.post,
                "https://api.assemblyai.com/v2/transcript",
                headers={"authorization": self.api_key},
                json=transcript_config,
                timeout=30
            )

            if transcript_response.status_code != 200:
                logger.error(
                    "[AssemblyAI Standard] Transcription request failed (%d): %s",
                    transcript_response.status_code,
                    transcript_response.text[:200]
                )
                return

            transcript_id = transcript_response.json()["id"]
            job_created_time = time.time()
            logger.info(
                "[AssemblyAI Standard] Transcription job created: %.0fms",
                (job_created_time - upload_complete_time) * 1000
            )

            # Step 4: Poll for result
            poll_count = 0
            while True:
                poll_count += 1

                status_response = await asyncio.to_thread(
                    self._requests.get,
                    f"https://api.assemblyai.com/v2/transcript/{transcript_id}",
                    headers={"authorization": self.api_key},
                    timeout=30
                )

                if status_response.status_code != 200:
                    logger.error(
                        "[AssemblyAI Standard] Status check failed (%d): %s",
                        status_response.status_code,
                        status_response.text[:200]
                    )
                    return

                result = status_response.json()
                status = result["status"]

                if status == "completed":
                    transcript_text = result.get("text", "").strip()
                    end_time = time.time()
                    total_latency = (end_time - start_time) * 1000

                    logger.info(
                        "[AssemblyAI Standard] Transcription completed after %d polls (%.0fms total): '%s'",
                        poll_count,
                        total_latency,
                        transcript_text[:100]
                    )

                    # Log latency breakdown
                    logger.info(
                        "[AssemblyAI Standard] Latency breakdown: File=%.0fms, Upload=%.0fms, Job=%.0fms, Poll=%.0fms",
                        (file_create_time - start_time) * 1000,
                        (upload_complete_time - file_create_time) * 1000,
                        (job_created_time - upload_complete_time) * 1000,
                        (end_time - job_created_time) * 1000
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
                        logger.debug("[AssemblyAI Standard] Skipping duplicate transcript")
                    else:
                        logger.debug("[AssemblyAI Standard] Empty transcript, skipping")

                    break

                elif status == "error":
                    error_msg = result.get("error", "Unknown error")
                    logger.error(f"[AssemblyAI Standard] Transcription error: {error_msg}")
                    break

                # Still processing, wait before polling again
                await asyncio.sleep(0.1)  # Poll every 100ms

        except Exception as e:
            logger.error(f"[AssemblyAI Standard] Transcription failed: {e}", exc_info=True)

    async def _safe_callback(self, text: str) -> None:
        """Safely call the transcript callback."""
        try:
            if asyncio.iscoroutinefunction(self.on_transcript):
                await self.on_transcript(text)
            else:
                self.on_transcript(text)
        except Exception as e:
            logger.error(f"[AssemblyAI Standard] Callback error: {e}", exc_info=True)

    async def close(self) -> None:
        """Clean up resources."""
        # Process any remaining audio
        if len(self.audio_buffer) >= self.min_audio_length_bytes:
            duration = len(self.audio_buffer) / (self.sample_rate * 2)
            logger.info(
                "[AssemblyAI Standard] Processing remaining %.1fs of audio...",
                duration
            )
            await self._transcribe_audio(bytes(self.audio_buffer))

        self.audio_buffer.clear()
        self.is_initialized = False

        logger.info(
            "[AssemblyAI Standard] Closed (processed %d transcriptions)",
            self._transcription_count
        )
