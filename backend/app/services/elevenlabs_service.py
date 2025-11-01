#!/usr/bin/env python3
"""Real-time ElevenLabs ConvAI WebSocket bridge"""

import asyncio
import base64
import json
import time
from typing import Dict, Optional, Callable, Any, List

import websockets
from elevenlabs.client import ElevenLabs

# Import configuration and logging
from ..core.config import get_settings
from ..core.logging_config import get_logger

# Initialize settings and logger
settings = get_settings()
logger = get_logger(__name__)


class ElevenLabsVoiceHandler:
    """Handles WebSocket communication with ElevenLabs ConvAI"""
    
    def __init__(self, api_key: str, agent_id: str):
        self.api_key = api_key
        self.agent_id = agent_id
        self.websocket_url = f"{settings.ELEVENLABS_WEBSOCKET_URL}?agent_id={agent_id}"
        self.websocket: Optional[websockets.WebSocketClientProtocol] = None
        self.is_connected = False

        # Callback registry
        self.response_callbacks: Dict[str, Callable] = {}

        # Outgoing audio buffering
        self._pcm_buffer = bytearray()
        self._flush_bytes = settings.AUDIO_FLUSH_BYTES
        self._last_flush = time.time()
        self._conversation_ready = False
        self._pending_audio_before_ready: List[bytes] = []
        
        # Successful payload format cache
        self._successful_payload_format: Optional[int] = None

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
                # Extract and log conversation ID if present
                conversation_id = data.get("conversation_id") or data.get("conversationId") or data.get("id")
                if conversation_id:
                    logger.info("[EL] Conversation ID: %s", conversation_id)
                else:
                    logger.debug("[EL] Conversation initiation metadata received (no conversation_id found): %s", list(data.keys()))
                
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

            # Tool calls (e.g., end_call) - handle various formats
            if "tool_call" in data:
                await self._notify("tool_call", data["tool_call"])
            elif "tool_calls" in data:
                for tool_call in data["tool_calls"]:
                    await self._notify("tool_call", tool_call)
            elif "function_call" in data:
                await self._notify("tool_call", data["function_call"])
            elif "function_calls" in data:
                for func_call in data["function_calls"]:
                    await self._notify("tool_call", func_call)
            # Check for tool calls nested in agent response events
            elif "agent_response_event" in data:
                agent_event = data["agent_response_event"]
                if "tool_call" in agent_event:
                    await self._notify("tool_call", agent_event["tool_call"])
                elif "tool_calls" in agent_event:
                    for tool_call in agent_event["tool_calls"]:
                        await self._notify("tool_call", tool_call)
                elif "function_call" in agent_event:
                    await self._notify("tool_call", agent_event["function_call"])

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
        if not self.is_connected or not pcm16:
            return
            
        # Handle audio before conversation is ready
        if not self._conversation_ready:
            # Retain only last ~1s of audio if not ready yet
            self._pending_audio_before_ready.append(pcm16)
            if len(self._pending_audio_before_ready) > 10:
                self._pending_audio_before_ready.pop(0)
            return
            
        # Add to buffer
        self._pcm_buffer.extend(pcm16)
        
        # Flush when buffer is large enough or enough time has passed
        buffer_size = len(self._pcm_buffer)
        time_since_flush = time.time() - self._last_flush
        
        # Flush criteria: buffer size or time threshold
        if buffer_size >= self._flush_bytes or time_since_flush > settings.AUDIO_FLUSH_INTERVAL:
            await self.flush()

    async def flush(self):
        if not self._pcm_buffer:
            return
        chunk = bytes(self._pcm_buffer)
        self._pcm_buffer.clear()
        await self._send_chunk(chunk)
        self._last_flush = time.time()

    async def _send_chunk(self, pcm16: bytes):
        """Send audio chunk to ElevenLabs with cached payload format for optimization"""
        if not (self.websocket and self.is_connected):
            return
            
        if not pcm16 or len(pcm16) == 0:
            return
            
        try:
            # Validate PCM data
            if len(pcm16) % 2 != 0:
                logger.warning("[EL] PCM data length not even (%d bytes), padding", len(pcm16))
                pcm16 = pcm16 + b'\x00'
                
            # Convert to base64
            b64 = base64.b64encode(pcm16).decode("utf-8")
            
            # Payload format variants (ordered by most common first)
            variants = [
                {"user_audio_chunk": b64},
                {"type": "user_audio_chunk", "user_audio_chunk": b64},
                {"audio_base64": b64},
                {"type": "audio", "audio_base64": b64},
            ]
            
            # If we have a cached successful format, use it
            if self._successful_payload_format is not None:
                try:
                    payload = variants[self._successful_payload_format]
                    await self.websocket.send(json.dumps(payload))
                    return
                except Exception:
                    # Cached format failed, reset and try all
                    logger.debug("[EL] Cached payload format failed, retrying")
                    self._successful_payload_format = None
            
            # Try each variant until one succeeds
            for idx, payload in enumerate(variants):
                try:
                    await self.websocket.send(json.dumps(payload))
                    self._successful_payload_format = idx
                    logger.info("[EL] Sent %d bytes using format #%d: %s",
                                len(pcm16), idx, list(payload.keys()))
                    return
                except Exception:
                    if idx == len(variants) - 1:
                        raise  # Last attempt failed
                    continue
                
        except Exception as e:
            # Handle graceful close (code 1000) without surfacing an error to the client
            try:
                from websockets.exceptions import ConnectionClosedOK  # type: ignore
            except Exception:  # pragma: no cover - compatibility
                ConnectionClosedOK = tuple()  # type: ignore

            if isinstance(e, ConnectionClosedOK) or "1000" in str(e):
                logger.info("[EL] Send skipped after close (1000 OK): %s", str(e))
                self.is_connected = False
                self._successful_payload_format = None
                asyncio.create_task(self.connect())
                return

            logger.error("[EL] Failed to send audio chunk: %s", str(e))
            await self._notify("error", f"Failed to send audio: {str(e)}")
            
            # Try to reconnect if connection is broken
            if "connection" in str(e).lower() or "closed" in str(e).lower():
                logger.warning("[EL] Connection broken, reconnecting...")
                self.is_connected = False
                self._successful_payload_format = None
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

    def register_tool_callback(self, cb: Callable):
        self.handler.register_callback("tool_call", cb)

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


