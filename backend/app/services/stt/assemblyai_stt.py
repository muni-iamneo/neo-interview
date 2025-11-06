"""
AssemblyAI Streaming STT service (v3 API) using Universal-Streaming model.

Provides ultra-low latency real-time speech-to-text with turn-based transcripts.
Achieves ~300ms latency (10× faster than Whisper CPU).
"""

import asyncio
import time
import json
import re
from typing import Optional, Callable
import websockets
import base64

from app.core.config import get_settings
from app.core.logging_config import get_logger
from app.services.voice_providers.base import BaseSTTProvider

settings = get_settings()
logger = get_logger(__name__)


class AssemblyAISTTService(BaseSTTProvider):
    """
    AssemblyAI Streaming STT implementation (v3 API).

    Uses AssemblyAI's Universal-Streaming model for ultra-low latency
    real-time transcription (~300ms).

    Features:
    - Turn-based transcripts (formatted for conversation)
    - Word-level timestamps and confidence scores
    - Automatic punctuation and casing
    - ~300ms latency (7× faster than Whisper)
    - Cloud API (no infrastructure management)
    """

    def __init__(self, on_transcript: Optional[Callable[[str], None]] = None):
        """
        Initialize AssemblyAI STT service.

        Args:
            on_transcript: Callback function called when transcript received.
        """
        self.api_key = settings.ASSEMBLYAI_API_KEY
        self.websocket = None
        self.is_initialized = False
        self.on_transcript = on_transcript
        self.sample_rate = settings.AUDIO_SAMPLE_RATE

        # Session state
        self.session_id = None
        self.is_connected = False
        self._begin_received = False  # Track if we've received Begin message
        self._receive_task = None

        # Audio buffering (AssemblyAI requires 50-1000ms chunks)
        # 50ms @ 16kHz = 1600 bytes (16-bit mono)
        # Use smaller max chunks (200ms) to avoid large messages and improve reliability
        self._audio_buffer = bytearray()
        self._min_chunk_bytes = int((self.sample_rate * 2 * 50) / 1000)  # 50ms minimum
        self._max_chunk_bytes = int((self.sample_rate * 2 * 200) / 1000)  # 200ms maximum (reduced from 1000ms)
        self._last_send_time = 0.0  # Track last send time for rate limiting

        # Performance metrics
        self._total_transcriptions = 0
        self._total_duration = 0.0
        self._total_characters = 0

    async def initialize(self) -> bool:
        """
        Initialize WebSocket connection to AssemblyAI.

        Returns:
            bool: True if initialization successful.
        """
        try:
            word_boost_param = ""
            if settings.ASSEMBLYAI_WORD_BOOST:
                keyterms = ",".join(settings.ASSEMBLYAI_WORD_BOOST)
                word_boost_param = f"&keyterms_prompt={keyterms}"

            # Connection parameters:
            # - inactivity_timeout: Keep connection alive for longer periods (default may be too short)
            # - max_turn_silence: Allow longer silence within a turn before ending
            ws_url = (
                f"wss://streaming.assemblyai.com/v3/ws"
                f"?sample_rate={self.sample_rate}"
                f"&encoding=pcm_s16le"
                f"&inactivity_timeout=300"  # 5 minutes of inactivity before closing
                f"&max_turn_silence=3000"   # 3 seconds of silence before ending turn
                f"{word_boost_param}"
            )

            logger.info("[AssemblyAI STT] Connecting to streaming API v3...")

            self.websocket = await websockets.connect(
                ws_url,
                additional_headers={
                    "Authorization": self.api_key
                },
                ping_interval=30,
                ping_timeout=10,
            )

            # Start receive loop (v3 API auto-sends Begin message upon connection)
            self._receive_task = asyncio.create_task(self._receive_loop())


            for i in range(20):  # Try for up to 2 seconds
                if self.is_connected:
                    logger.info(
                        "[AssemblyAI STT] Connected successfully: session_id=%s",
                        self.session_id
                    )
                    self.is_initialized = True
                    return True
                await asyncio.sleep(0.1)

            logger.error("[AssemblyAI STT] Failed to receive Begin message after 2 seconds")
            if self.websocket:
                try:
                    await self.websocket.close()
                except:
                    pass
            return False

        except Exception as e:
            logger.error("[AssemblyAI STT] Failed to initialize: %s", e)
            self.is_initialized = False
            return False

    async def process_audio(self, pcm16: bytes) -> Optional[str]:
        """
        Stream audio chunk to AssemblyAI for real-time transcription.

        Buffers incoming audio chunks until we have at least 50ms worth of data
        (AssemblyAI requirement) before sending to the API.

        Note: Transcripts are received asynchronously via the receive loop
        and delivered through the on_transcript callback.

        Args:
            pcm16: Raw PCM16 audio bytes @ 16kHz.

        Returns:
            Optional[str]: None (transcripts delivered via callback).
        """
        if not self.is_initialized or not self.websocket:
            logger.warning("[AssemblyAI STT] Not initialized, cannot process audio")
            return None

        if not self.is_connected:
            logger.debug("[AssemblyAI STT] Not connected yet, skipping audio chunk")
            return None

        if not pcm16:
            return None

        try:
            # Validate input
            if not pcm16 or len(pcm16) == 0:
                logger.debug("[AssemblyAI STT] Received empty audio chunk, skipping")
                return None

            # Add to buffer
            self._audio_buffer.extend(pcm16)

            # Check if buffer has enough data to send (minimum 50ms)
            # Only send when we have at least the minimum chunk size
            if len(self._audio_buffer) >= self._min_chunk_bytes:
                # Send accumulated audio
                await self._send_buffered_audio()

            # Transcripts will be received in _receive_loop
            return None

        except websockets.exceptions.ConnectionClosed as e:
            logger.warning(
                "[AssemblyAI STT] Connection closed while sending audio: code=%s, reason=%s",
                e.code,
                e.reason
            )
            self.is_connected = False
            return None
        except Exception as e:
            logger.error("[AssemblyAI STT] Failed to send audio: %s", e, exc_info=True)
            return None

    async def _send_buffered_audio(self):
        """Send buffered audio to AssemblyAI, respecting chunk size limits."""
        if not self._audio_buffer or len(self._audio_buffer) == 0:
            logger.warning("[AssemblyAI STT] Attempted to send empty audio buffer")
            return

        # Extract up to max_chunk_bytes (1000ms) from buffer
        chunk_size = min(len(self._audio_buffer), self._max_chunk_bytes)
        chunk = bytes(self._audio_buffer[:chunk_size])
        self._audio_buffer = self._audio_buffer[chunk_size:]

        # Validate chunk is not empty
        if len(chunk) == 0:
            logger.warning("[AssemblyAI STT] Chunk is empty after extraction")
            return

        chunk_duration_ms = (len(chunk) / (self.sample_rate * 2)) * 1000

        # Check if chunk is completely silent (all zeros)
        # AssemblyAI may reject too many silent chunks
        is_silent = all(b == 0 for b in chunk)
        if is_silent:
            # Skip completely silent chunks - don't send to AssemblyAI
            # This prevents "Invalid Message Type" errors from too many silent packets
            logger.debug(
                "[AssemblyAI STT] Skipping silent chunk: %d bytes (%.1fms)",
                len(chunk),
                chunk_duration_ms
            )
            return

        # CRITICAL: Only send audio after Begin message is received
        # AssemblyAI will reject audio sent before Begin message
        if not self._begin_received:
            logger.warning("[AssemblyAI STT] Begin message not received yet, skipping audio send")
            return

        # Verify connection is still active before sending
        if not self.is_connected:
            logger.warning("[AssemblyAI STT] Connection lost, skipping audio send")
            return

        if not self.websocket:
            logger.warning("[AssemblyAI STT] WebSocket is None, skipping audio send")
            return

        try:
            # AssemblyAI v3 API format based on encoding parameter:
            # - When encoding=pcm_s16le is specified in URL, send raw PCM binary frames
            # - When no encoding specified, use JSON with base64
            # Since we specify encoding=pcm_s16le, we should send binary frames
            # 
            # Rate limiting: Ensure minimum 20ms between sends to avoid overwhelming API
            current_time = time.time()
            time_since_last_send = current_time - self._last_send_time
            min_send_interval = 0.02  # 20ms minimum interval
            
            if time_since_last_send < min_send_interval:
                await asyncio.sleep(min_send_interval - time_since_last_send)
            
            # Log the message being sent (reduced verbosity)
            logger.debug(
                "[AssemblyAI STT] Sending audio: %d bytes PCM (%.1fms)",
                len(chunk),
                chunk_duration_ms
            )

            # Send as binary frame
            await self.websocket.send(chunk)
            self._last_send_time = time.time()
        except websockets.exceptions.ConnectionClosed as e:
            logger.warning(
                "[AssemblyAI STT] Connection closed while sending audio: code=%s, reason=%s",
                e.code,
                e.reason
            )
            self.is_connected = False
            raise
        except Exception as e:
            logger.error(
                "[AssemblyAI STT] Failed to encode/send audio chunk: %s (chunk_size=%d, duration=%.1fms)",
                e,
                len(chunk),
                chunk_duration_ms,
                exc_info=True
            )
            raise


    async def flush(self) -> Optional[str]:
        """
        Flush any buffered audio.

        Sends any remaining buffered audio to AssemblyAI, even if it's less
        than the minimum chunk size.

        Returns:
            Optional[str]: None.
        """
        if self._audio_buffer and len(self._audio_buffer) > 0:
            try:
                await self._send_buffered_audio()
            except Exception as e:
                logger.error("[AssemblyAI STT] Failed to flush audio: %s", e)
        return None

    async def _receive_loop(self):
        """
        Continuously receive messages from AssemblyAI WebSocket (v3 API).

        Handles:
        - SessionBegins: Connection confirmation
        - Turn: Formatted turn-based transcription (final transcripts)
        - Termination: Session termination
        """
        try:
            async for message in self.websocket:
                try:
                    data = json.loads(message)
                    message_type = data.get("type")

                    if message_type == "Begin":
                        # V3 API: Begin message confirms session started
                        self.session_id = data.get("id")
                        expires_at = data.get("expires_at", "N/A")
                        logger.info(
                            "[AssemblyAI STT] Session begins: id=%s, expires_at=%s, ready to receive audio",
                            self.session_id,
                            expires_at
                        )
                        # Mark Begin received BEFORE setting is_connected to ensure proper ordering
                        self._begin_received = True
                        # Small delay to ensure Begin message is fully processed server-side
                        await asyncio.sleep(0.2)
                        # Set connected flag after Begin is confirmed
                        self.is_connected = True

                    elif message_type == "Turn":
                        # V3 API: Turn-based transcription result
                        start_time = time.time()

                        utterance = data.get("utterance", "")
                        text = data.get("transcript", "")
                        language_confidence = data.get("language_confidence", 0.0)
                        words = data.get("words", [])
                        end_of_turn = data.get("end_of_turn", False)

                        final_text = utterance if utterance else text

                        if final_text:
                            duration = time.time() - start_time
                            self._total_transcriptions += 1
                            self._total_duration += duration
                            self._total_characters += len(final_text)

                            logger.info(
                                "[AssemblyAI STT] Turn: '%s' (utterance=%s, transcript=%s, lang_conf=%.2f, words=%d, end_of_turn=%s)",
                                final_text[:100],
                                bool(utterance),
                                bool(text),
                                language_confidence,
                                len(words),
                                end_of_turn
                            )

                            # For real-time TTS: Process BOTH partial utterances AND final end_of_turn
                            # This ensures TTS happens as soon as we have meaningful speech segments
                            if self.on_transcript:
                                if end_of_turn:
                                    # Final turn completion - always send
                                    logger.debug("[AssemblyAI STT] Sending final turn transcript")
                                    await self._safe_callback(final_text)
                                elif utterance:
                                    # Partial utterance - send for real-time processing
                                    # This allows TTS to start while user is still speaking
                                    logger.debug("[AssemblyAI STT] Sending partial utterance for real-time TTS")
                                    await self._safe_callback(utterance)
                                elif text:
                                    # Intermediate transcript (text without utterance) - send for processing
                                    # Some AssemblyAI messages provide text without utterance field
                                    logger.debug("[AssemblyAI STT] Sending intermediate transcript")
                                    await self._safe_callback(text)

                    elif message_type == "Termination":
                        reason = data.get("reason", "unknown")
                        audio_duration = data.get("audio_duration_seconds", 0.0)
                        session_duration = data.get("session_duration_seconds", 0.0)
                        
                        logger.info(
                            "[AssemblyAI STT] Session terminated: reason=%s, audio_duration=%.2fs, session_duration=%.2fs",
                            reason,
                            audio_duration,
                            session_duration
                        )
                        self.is_connected = False
                        break

                    elif message_type == "Error":
                        error_message = data.get("error", "Unknown error")
                        error_code = data.get("code", "N/A")
                        error_type = data.get("type", "N/A")
                        logger.error(
                            "[AssemblyAI STT] Server error: code=%s, type=%s, message=%s, full_data=%s",
                            error_code,
                            error_type,
                            error_message,
                            data
                        )
                        self.is_connected = False
                        break

                    else:
                        logger.debug(
                            "[AssemblyAI STT] Unknown message type: %s, data keys: %s",
                            message_type,
                            list(data.keys()) if isinstance(data, dict) else "N/A"
                        )

                except json.JSONDecodeError as e:
                    logger.error("[AssemblyAI STT] Failed to decode message: %s, raw message: %s", e, message[:200])
                except Exception as e:
                    logger.error("[AssemblyAI STT] Error processing message: %s", e, exc_info=True)

        except websockets.exceptions.ConnectionClosed as e:
            logger.warning(
                "[AssemblyAI STT] WebSocket connection closed: code=%s, reason=%s",
                getattr(e, 'code', 'N/A'),
                getattr(e, 'reason', 'N/A')
            )
            self.is_connected = False
        except Exception as e:
            logger.error("[AssemblyAI STT] Receive loop error: %s", e, exc_info=True)
            self.is_connected = False

    async def _safe_callback(self, text: str):
        """
        Safely execute transcript callback.

        Args:
            text: Transcribed text.
        """
        try:
            if asyncio.iscoroutinefunction(self.on_transcript):
                await self.on_transcript(text)
            else:
                self.on_transcript(text)
        except Exception as e:
            logger.error("[AssemblyAI STT] Callback error: %s", e)

    async def cleanup(self) -> None:
        """Clean up WebSocket connection and resources."""
        try:
            if self.websocket:
                try:
                    # Send terminate message (v3 API)
                    terminate_message = json.dumps({
                        "type": "Terminate"
                    })
                    if not isinstance(terminate_message, str):
                        logger.error("[AssemblyAI STT] terminate_message is not a string")
                        return
                    await self.websocket.send(terminate_message)
                    await asyncio.sleep(0.1)

                    await self.websocket.close()
                    logger.info("[AssemblyAI STT] WebSocket closed")
                except Exception as ws_error:
                    logger.warning("[AssemblyAI STT] WebSocket close error: %s", ws_error)

            if self._receive_task and not self._receive_task.done():
                self._receive_task.cancel()
                try:
                    await self._receive_task
                except asyncio.CancelledError:
                    pass

            self.is_initialized = False
            self.is_connected = False

            if self._total_transcriptions > 0:
                avg_duration = (self._total_duration / self._total_transcriptions) * 1000
                avg_chars = self._total_characters / self._total_transcriptions
                logger.info(
                    "[AssemblyAI STT] Cleanup: %d transcriptions, avg %.2fms, avg %.1f chars",
                    self._total_transcriptions,
                    avg_duration,
                    avg_chars,
                )

        except Exception as e:
            logger.error("[AssemblyAI STT] Cleanup error: %s", e)

    def get_metrics(self) -> dict:
        """Get performance metrics."""
        avg_duration = 0.0
        avg_chars = 0.0

        if self._total_transcriptions > 0:
            avg_duration = (self._total_duration / self._total_transcriptions) * 1000
            avg_chars = self._total_characters / self._total_transcriptions

        return {
            "total_transcriptions": self._total_transcriptions,
            "total_duration_ms": self._total_duration * 1000,
            "avg_duration_ms": avg_duration,
            "total_characters": self._total_characters,
            "avg_characters": avg_chars,
            "is_connected": self.is_connected,
            "session_id": self.session_id,
        }


# Singleton instance
_assemblyai_stt: Optional[AssemblyAISTTService] = None


def get_assemblyai_stt(on_transcript: Optional[Callable[[str], None]] = None) -> AssemblyAISTTService:
    """
    Get or create AssemblyAI STT service instance.

    Args:
        on_transcript: Callback for transcripts.

    Returns:
        AssemblyAISTTService instance.
    """
    global _assemblyai_stt
    if _assemblyai_stt is None:
        _assemblyai_stt = AssemblyAISTTService(on_transcript)
    return _assemblyai_stt
