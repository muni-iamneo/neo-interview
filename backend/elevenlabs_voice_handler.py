#!/usr/bin/env python3
"""Real-time ElevenLabs ConvAI WebSocket bridge used by FastAPI endpoint.

Replaces earlier stub; supports continuous audio after join.
"""

import asyncio
import base64
import json
import logging
import os
import time
from typing import Dict, Optional, Callable, Any, List

import websockets
from elevenlabs.client import ElevenLabs  # retained for possible future REST use
from dotenv import load_dotenv

load_dotenv()

logger = logging.getLogger("elevenlabs_voice")
if not logger.handlers:
    logging.basicConfig(level=logging.INFO)


class ElevenLabsVoiceHandler:
    def __init__(self, api_key: str, agent_id: str):
        # Connection / auth
        self.api_key = api_key
        self.agent_id = agent_id
        self.websocket_url = f"wss://api.elevenlabs.io/v1/convai/conversation?agent_id={agent_id}"
        self.websocket: Optional[websockets.WebSocketClientProtocol] = None
        self.is_connected = False

        # Callback registry
        self.response_callbacks = {}  # type: Dict[str, Callable]

        # Outgoing audio buffering
        self._pcm_buffer = bytearray()
        self._flush_bytes = 3200  # ≈100ms @16k (16000 *2 bytes *0.1)
        self._last_flush = time.time()
        self._conversation_ready = False
        self._pending_audio_before_ready = []  # type: List[bytes]

    async def connect(self) -> bool:
        if self.is_connected and self.websocket:
            return True
        try:
            try:
                # Newer versions of websockets (>=10) support extra_headers (dict or list)
                self.websocket = await websockets.connect(
                    self.websocket_url,
                    extra_headers={"xi-api-key": self.api_key},
                    max_size=None,
                )
            except TypeError:
                # Fallback for older versions expecting additional_headers as list of tuples
                self.websocket = await websockets.connect(
                    self.websocket_url,
                    additional_headers=[("xi-api-key", self.api_key)],
                    max_size=None,
                )
            self.is_connected = True
            logger.info("[EL] Connected %s", self.websocket_url)
            asyncio.create_task(self._listen())
            return True
        except Exception as e:
            logger.error("[EL] Connect failed: %s", e)
            self.is_connected = False
            return False

    async def disconnect(self):
        if self.websocket:
            try:
                await self.websocket.close()
            except Exception:
                pass
        self.is_connected = False
        logger.info("[EL] Disconnected")

    async def _listen(self):
        if not self.websocket:
            return
        try:
            async for raw in self.websocket:
                logger.debug("[EL] <- frame %s", raw[:120] if isinstance(raw, str) else type(raw))
                try:
                    data = json.loads(raw)
                except Exception:
                    logger.debug("[EL] Non-JSON frame: %r", raw[:60])
                    continue
                await self._handle_event(data)
        except websockets.exceptions.ConnectionClosed as cc:
            logger.info("[EL] Socket closed code=%s reason=%s", getattr(cc, 'code', '?'), getattr(cc, 'reason', '?'))
        except Exception as e:
            logger.error("[EL] Listener error: %s", e)
        finally:
            self.is_connected = False

    async def _handle_event(self, data: dict):
        try:
            evt_type = data.get("type")
            if evt_type == "conversation_initiation_metadata":
                await self._notify("status", data)
                if not self._conversation_ready:
                    self._conversation_ready = True
                    if self._pending_audio_before_ready:
                        logger.info("[EL] Flushing %d buffered pre-init audio chunks", len(self._pending_audio_before_ready))
                        for buf in self._pending_audio_before_ready:
                            self._pcm_buffer.extend(buf)
                        self._pending_audio_before_ready.clear()
                        if self._pcm_buffer:
                            await self.flush()
                return

            # Audio
            audio_b64 = None
            if "audio_event" in data:
                ev = data["audio_event"]
                audio_b64 = ev.get("audio_base64") or ev.get("audio") or ev.get("audio_base_64")
            elif "audio_base64" in data:
                audio_b64 = data["audio_base64"]
            elif "audio" in data and isinstance(data["audio"], str):
                audio_b64 = data["audio"]
            if audio_b64:
                try:
                    pcm = base64.b64decode(audio_b64)
                    await self._notify("audio_response", pcm)
                except Exception as de:
                    logger.warning("[EL] Audio decode fail: %s", de)

            # Text
            if "agent_response_event" in data:
                txt = data["agent_response_event"].get("agent_response") or data["agent_response_event"].get("text")
                if txt:
                    await self._notify("text_response", txt)
            elif isinstance(data.get("text"), str):
                await self._notify("text_response", data["text"])

            if evt_type == "ping":
                await self._notify("ping", data)

            if "error" in data:
                await self._notify("error", data["error"])

            logger.debug("[EL] Event %s", data)
        except Exception as e:
            logger.error("[EL] Event handling error: %s", e)

    async def start_conversation(self) -> bool:
        if not self.is_connected and not await self.connect():
            return False
        try:
            # Optional agent validation (helps diagnose 'misconfigured agent')
            try:
                client = ElevenLabs(api_key=self.api_key)
                agent_iface = getattr(client, "conversational_ai", None)
                agent_iface = getattr(agent_iface, "agents", None)
                if agent_iface and hasattr(agent_iface, "get"):
                    meta = agent_iface.get(self.agent_id)
                    # Best effort to coerce to dict for logging
                    meta_dict = getattr(meta, '__dict__', {}) or {}
                    logger.info("[EL] Agent meta name=%s voice=%s llm=%s", meta_dict.get('name'), meta_dict.get('default_voice_id') or meta_dict.get('voice_id'), meta_dict.get('llm_model'))
                    logger.debug("[EL] Full agent meta: %s", meta_dict)
            except Exception as e:
                logger.warning("[EL] Agent metadata fetch failed (continuing): %s", e)

            # Wait up to 5s for server to send initiation metadata; do NOT push our own init (some API versions reject it)
            ready = await self._await_ready(timeout=5.0)
            if not ready:
                logger.error("[EL] Conversation initiation metadata not received within timeout")
                return False
            logger.info("[EL] Conversation ready (metadata received)")
            return True
        except Exception as e:
            logger.error("[EL] Init failed: %s", e)
            return False

    async def _await_ready(self, timeout: float) -> bool:
        start = time.time()
        while time.time() - start < timeout:
            if self._conversation_ready:
                return True
            await asyncio.sleep(0.05)
        return False

    async def queue_pcm(self, pcm16: bytes):
        """Queue PCM audio data for sending to ElevenLabs
        
        This method handles buffering and flushing of audio data to ensure
        optimal chunk sizes for the ElevenLabs API.
        """
        if not self.is_connected:
            logger.debug("[EL] Not connected, ignoring audio data")
            return
            
        # Check if we have valid audio data
        if not pcm16 or len(pcm16) == 0:
            logger.debug("[EL] Empty audio data received, ignoring")
            return
            
        # Handle audio before conversation is ready
        if not self._conversation_ready:
            # Retain only last ~1s of audio if not ready yet
            self._pending_audio_before_ready.append(pcm16)
            if len(self._pending_audio_before_ready) > 10:
                self._pending_audio_before_ready.pop(0)
            
            # Log the buffer size periodically
            total_pending = sum(len(chunk) for chunk in self._pending_audio_before_ready)
            logger.debug("[EL] Buffering audio until ready: %d bytes in %d chunks", 
                        total_pending, len(self._pending_audio_before_ready))
            return
            
        # Add to buffer
        self._pcm_buffer.extend(pcm16)
        
        # Flush when buffer is large enough or enough time has passed
        buffer_size = len(self._pcm_buffer)
        time_since_flush = time.time() - self._last_flush
        
        # Log buffer status for debugging
        logger.debug("[EL] Buffer status: %d bytes, %.2fs since last flush", 
                    buffer_size, time_since_flush)
        
        # Flush criteria: either buffer size or time threshold
        if buffer_size >= self._flush_bytes or time_since_flush > 0.5:
            logger.debug("[EL] Flushing %d bytes of audio (time: %.2fs)", 
                        buffer_size, time_since_flush)
            await self.flush()

    async def flush(self):
        if not self._pcm_buffer:
            return
        chunk = bytes(self._pcm_buffer)
        self._pcm_buffer.clear()
        await self._send_chunk(chunk)
        self._last_flush = time.time()

    async def _send_chunk(self, pcm16: bytes):
        """Send audio chunk to ElevenLabs with enhanced error handling and logging"""
        if not (self.websocket and self.is_connected):
            logger.debug("[EL] Cannot send chunk - not connected")
            return
            
        # Skip empty chunks
        if not pcm16 or len(pcm16) == 0:
            logger.debug("[EL] Skipping empty chunk")
            return
            
        try:
            # Validate PCM data (should be even length for 16-bit samples)
            if len(pcm16) % 2 != 0:
                logger.warning("[EL] PCM data length is not even (%d bytes), padding", len(pcm16))
                pcm16 = pcm16 + b'\x00'  # Pad with a zero byte
                
            # Convert to base64
            b64 = base64.b64encode(pcm16).decode("utf-8")
            
            # Try different payload formats (ElevenLabs API versions differ)
            variants = [
                {"user_audio_chunk": b64},
                {"type": "user_audio_chunk", "user_audio_chunk": b64},
                {"type": "audio", "audio_base64": b64},
                {"audio_base64": b64},
                {"type": "audio", "audio": b64},
                # Add continuous flag for better streaming
                {"user_audio_chunk": b64, "stream_type": "continuous"},
            ]
            
            # Try each variant until one succeeds
            last_err = None
            success = False
            
            for idx, payload in enumerate(variants):
                try:
                    await self.websocket.send(json.dumps(payload))
                    logger.debug("[EL] -> Sent %d bytes (format #%d: %s)", 
                                len(pcm16), idx, list(payload.keys()))
                    success = True
                    break
                except Exception as pe:
                    last_err = pe
                    # Only log if we're on the last attempt
                    if idx == len(variants) - 1:
                        logger.warning("[EL] All payload formats failed: %s", pe)
                    continue
            
            # Log previous errors if we eventually succeeded
            if success and last_err:
                logger.debug("[EL] Note: %d earlier payload attempts failed before success", 
                            variants.index(payload))
                
            # If all attempts failed, raise the last error
            if not success and last_err:
                raise last_err
                
        except Exception as e:
            logger.error("[EL] Failed to send audio chunk: %s", e)
            await self._notify("error", f"Failed to send audio: {str(e)}")
            
            # Try to reconnect if connection seems broken
            if "connection" in str(e).lower() or "closed" in str(e).lower():
                logger.warning("[EL] Connection may be broken, attempting to reconnect...")
                self.is_connected = False
                asyncio.create_task(self.connect())

    def register_callback(self, event: str, cb: Callable):
        self.response_callbacks[event] = cb

    async def _notify(self, event: str, payload: Any):
        cb = self.response_callbacks.get(event)
        if not cb:
            return
        try:
            if asyncio.iscoroutinefunction(cb):
                await cb(payload)
            else:
                cb(payload)
        except Exception as e:
            logger.error("[EL] Callback %s failed: %s", event, e)

    def is_ready(self) -> bool:
        return self.is_connected and self.websocket is not None


class JitsiElevenLabsBridge:
    def __init__(self, api_key: str, agent_id: str):
        self.handler = ElevenLabsVoiceHandler(api_key, agent_id)
        self._started = False

    async def initialize(self):
        return await self.handler.connect()

    async def process_audio_chunk(self, pcm16: bytes):
        """Queue audio ONLY after conversation explicitly started.

        We removed implicit auto-start so upstream code (session) can apply VAD
        and only trigger the agent after real user speech to avoid proactive
        greeting responses on silence / join noise.
        """
        try:
            if not self._started:
                # Silently drop audio until start_conversation() called.
                return
            await self.handler.queue_pcm(pcm16)
        except Exception as e:
            await self.handler._notify("error", f"process_audio_chunk: {e}")

    def register_audio_callback(self, cb: Callable):
        self.handler.register_callback("audio_response", cb)

    def register_text_callback(self, cb: Callable):
        self.handler.register_callback("text_response", cb)

    def register_error_callback(self, cb: Callable):
        self.handler.register_callback("error", cb)

    async def start_conversation(self):
        if not self._started:
            self._started = await self.handler.start_conversation()
        return self._started

    def has_started(self) -> bool:
        return self._started

    async def cleanup(self):
        await self.handler.flush()
        await self.handler.disconnect()

    def is_ready(self) -> bool:
        return self.handler.is_ready()


async def _demo():  # Manual test helper
    api_key = os.getenv("ELEVENLABS_API_KEY")
    agent_id = os.getenv("ELEVENLABS_AGENT_ID")
    if not (api_key and agent_id):
        print("Set ELEVENLABS_API_KEY & ELEVENLABS_AGENT_ID")
        return
    bridge = JitsiElevenLabsBridge(api_key, agent_id)
    await bridge.initialize()
    await bridge.start_conversation()
    # 1 second of silence
    await bridge.process_audio_chunk(b"\x00" * 32000)
    await asyncio.sleep(2)
    await bridge.cleanup()

if __name__ == "__main__":
    asyncio.run(_demo())
