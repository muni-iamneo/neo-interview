#!/usr/bin/env python3
"""
Integrated Voice Endpoint for Jitsi + ElevenLabs
Handles WebSocket connections and voice session management
"""

import asyncio
import json
import math
import time
from typing import Dict, Optional
from fastapi import WebSocket, WebSocketDisconnect

# Import configuration and logging
from ..core.config import get_settings
from ..core.logging_config import get_logger

# Import services
from .cleanup_service import get_cleanup_service
from .elevenlabs_service import JitsiElevenLabsBridge
from .session_config import get_session_config, clear_session_config
from .sessions_service import get_sessions_service, SessionStatus

# Initialize settings and logger
settings = get_settings()
logger = get_logger(__name__)
cleanup_service = get_cleanup_service()

class IntegratedVoiceSession:
    """Manages a single voice conversation session"""

    def __init__(self, session_id: str, websocket: WebSocket):
        self.session_id = session_id
        self.websocket = websocket
        self.bridge: Optional[JitsiElevenLabsBridge] = None
        self.is_active = False
        self.audio_buffer = bytearray()
        self.chunk_size = settings.AUDIO_CHUNK_SIZE
        # VAD tracking before conversation start
        self._pre_start_chunks = 0
        self._rms_accum = 0.0
        self._rms_samples = 0
        # Interview timing
        self._interview_start_time: Optional[float] = None
        self._max_interview_minutes: Optional[int] = None
        self._duration_check_task: Optional[asyncio.Task] = None
        
    async def initialize(self) -> bool:
        """Initialize the voice conversation"""
        try:
            if not settings.ELEVENLABS_API_KEY:
                logger.error("[Session %s] Missing ElevenLabs API key", self.session_id)
                await self.websocket.send_json({
                    "type": "error",
                    "message": "Missing ElevenLabs API key"
                })
                return False
            
            # Get agent ID - check session config first, then fallback to .env
            agent_id = settings.ELEVENLABS_AGENT_ID
            session_config = get_session_config(self.session_id)
            
            if session_config:
                agent_id = session_config.eleven_agent_id
                self._max_interview_minutes = session_config.max_interview_minutes
                logger.info("[Session %s] Using per-session agent: %s max_minutes=%s", 
                           self.session_id, agent_id, self._max_interview_minutes)
            else:
                logger.info("[Session %s] Using default agent from .env: %s", self.session_id, agent_id)
            
            if not agent_id:
                logger.error("[Session %s] No agent ID configured", self.session_id)
                await self.websocket.send_json({
                    "type": "error",
                    "message": "No agent configured for this session"
                })
                return False
            
            # Create bridge
            self.bridge = JitsiElevenLabsBridge(
                settings.ELEVENLABS_API_KEY,
                agent_id
            )
            
            # Register callbacks
            self.bridge.register_audio_callback(self._on_audio_response)
            self.bridge.register_text_callback(self._on_text_response)
            self.bridge.register_error_callback(self._on_error)
            self.bridge.register_tool_callback(self._on_tool_call)
            
            # Initialize
            if not await self.bridge.initialize():
                logger.error("[Session %s] Failed to connect to ElevenLabs", self.session_id)
                await self.websocket.send_json({
                    "type": "error",
                    "message": "Failed to connect to ElevenLabs"
                })
                return False
            
            # Wait for speech (VAD) before starting conversation
            self.is_active = True
            await self.websocket.send_json({
                "type": "status",
                "message": "Voice bridge connected (waiting for speech)",
                "status": "connected",
                "started": False
            })

            logger.info("[Session %s] Voice bridge ready (awaiting speech to start agent)", self.session_id)
            return True
            
        except Exception as e:
            logger.error("[Session %s] Initialization error: %s", self.session_id, str(e), exc_info=True)
            await self.websocket.send_json({
                "type": "error",
                "message": f"Initialization failed: {str(e)}"
            })
            return False
    
    async def process_audio(self, audio_data: bytes):
        """Process incoming audio from Jitsi in real-time"""
        if not self.is_active or not self.bridge:
            return
        
        try:
            # If conversation not started, run VAD
            if not self.bridge.has_started():
                speech, rms = self._is_speech(audio_data, return_rms=True)
                self._pre_start_chunks += 1
                self._rms_accum += rms
                self._rms_samples += 1
                avg_rms = self._rms_accum / self._rms_samples if self._rms_samples else 0
                
                if self._pre_start_chunks % 10 == 0:
                    logger.debug(
                        "[Session %s] Pre-start VAD: chunks=%d last_rms=%.4f avg_rms=%.4f",
                        self.session_id, self._pre_start_chunks, rms, avg_rms
                    )

                # Start conversation conditions
                should_start = (
                    speech or
                    (self._pre_start_chunks >= settings.VAD_PRE_START_CHUNKS and avg_rms > settings.VAD_MIN_RMS) or
                    self._pre_start_chunks >= settings.VAD_AUTO_START_CHUNKS
                )
                
                if should_start:
                    ok = await self.bridge.start_conversation()
                    if ok:
                        reason = "speech" if speech else ("avg_rms" if avg_rms > settings.VAD_MIN_RMS else "timeout")
                        self._interview_start_time = time.time()
                        
                        # Update session with interview start time
                        sessions_service = get_sessions_service()
                        try:
                            await sessions_service.update_session(
                                self.session_id,
                                interview_start_time=self._interview_start_time,
                                last_activity=self._interview_start_time,
                            )
                        except Exception as e:
                            logger.warning("[Session %s] Failed to update interview start time: %s", self.session_id, str(e))
                        
                        # Start duration monitoring task if max minutes is set
                        if self._max_interview_minutes and not self._duration_check_task:
                            self._duration_check_task = asyncio.create_task(self._monitor_interview_duration())
                        
                        await self.websocket.send_json({
                            "type": "status",
                            "message": "Conversation started (VAD/auto)",
                            "status": "started",
                            "started": True,
                            "reason": reason,
                            "max_minutes": self._max_interview_minutes
                        })
                        logger.info(
                            "[Session %s] Conversation started: reason=%s rms=%.4f avg=%.4f max_minutes=%s",
                            self.session_id, reason, rms, avg_rms, self._max_interview_minutes
                        )
                
                if not self.bridge.has_started():
                    return
            
            # Forward audio to bridge
            await self.bridge.process_audio_chunk(audio_data)
            
        except Exception as e:
            logger.error("[Session %s] Audio processing error: %s", self.session_id, str(e), exc_info=True)
    
    async def _on_audio_response(self, audio_data: bytes):
        """Handle audio response from ElevenLabs agent"""
        if not self.is_active:
            return
            
        try:
            await self.websocket.send_bytes(audio_data)
            
            await self.websocket.send_json({
                "type": "audio_response",
                "size": len(audio_data),
                "timestamp": time.time()
            })
            
        except (WebSocketDisconnect, RuntimeError) as e:
            logger.warning("[Session %s] Client disconnected during audio send: %s", self.session_id, str(e))
            self.is_active = False
        except Exception as e:
            logger.error("[Session %s] Error sending audio response: %s", self.session_id, str(e))
    
    async def _on_text_response(self, text: str):
        """Handle text response from ElevenLabs agent"""
        if not self.is_active:
            return
            
        try:
            await self.websocket.send_json({
                "type": "text_response",
                "text": text,
                "timestamp": time.time()
            })
        except (WebSocketDisconnect, RuntimeError) as e:
            logger.warning("[Session %s] Client disconnected during text send: %s", self.session_id, str(e))
            self.is_active = False
        except Exception as e:
            logger.error("[Session %s] Error sending text response: %s", self.session_id, str(e))

    def _is_speech(self, pcm16: bytes, return_rms: bool = False):
        """Simple energy-based VAD with optional RMS return"""
        if not pcm16:
            return (False, 0.0) if return_rms else False

        sample_count = len(pcm16) // 2
        if sample_count == 0:
            return (False, 0.0) if return_rms else False

        total = 0.0
        step = 4  # Stride over samples to reduce work
        limit = sample_count - (sample_count % step)
        for i in range(0, limit, step):
            lo = pcm16[2 * i]
            hi = pcm16[2 * i + 1]
            val = (hi << 8) | lo
            if val & 0x8000:
                val = -((~val & 0xFFFF) + 1)
            total += (val * val)

        used = limit // step if step else sample_count
        if used == 0:
            return (False, 0.0) if return_rms else False

        rms = math.sqrt(total / used) / 32768.0
        is_speech = rms > settings.VAD_THRESHOLD
        return (is_speech, rms) if return_rms else is_speech
    
    async def _on_error(self, error: str):
        """Handle errors from ElevenLabs"""
        try:
            await self.websocket.send_json({
                "type": "error",
                "message": f"ElevenLabs error: {error}",
                "timestamp": time.time()
            })
        except Exception as e:
            logger.error("[Session %s] Error sending error message: %s", self.session_id, str(e))
    
    async def _on_tool_call(self, tool_data: dict):
        """Handle tool calls from ElevenLabs (e.g., end_call)"""
        try:
            # Handle different tool call formats
            tool_name = (
                tool_data.get("name") or 
                tool_data.get("tool_name") or 
                tool_data.get("function_name") or
                tool_data.get("function")
            )
            
            logger.debug("[Session %s] Received tool call: %s", self.session_id, tool_name)
            
            if tool_name == "end_call":
                logger.info("[Session %s] Agent requested to end call via end_call tool", self.session_id)
                await self._end_interview("agent_requested", can_rejoin=False)
            else:
                logger.debug("[Session %s] Unhandled tool call: %s", self.session_id, tool_name)
        except Exception as e:
            logger.error("[Session %s] Error handling tool call: %s", self.session_id, str(e), exc_info=True)
    
    async def _monitor_interview_duration(self):
        """Background task to monitor interview duration and force-end if time limit exceeded"""
        if not self._max_interview_minutes or not self._interview_start_time:
            return
        
        max_seconds = self._max_interview_minutes * 60
        check_interval = 10  # Check every 10 seconds
        
        try:
            while self.is_active:
                await asyncio.sleep(check_interval)
                
                if not self._interview_start_time:
                    continue
                
                elapsed = time.time() - self._interview_start_time
                remaining = max_seconds - elapsed
                
                # Log warning at 1 minute remaining
                if 0 < remaining <= 60:
                    logger.warning("[Session %s] Interview ending in %.0f seconds", self.session_id, remaining)
                    try:
                        await self.websocket.send_json({
                            "type": "warning",
                            "message": f"Interview ending in {int(remaining)} seconds",
                            "remaining_seconds": int(remaining)
                        })
                    except Exception:
                        pass
                
                # Force end if time exceeded
                if elapsed >= max_seconds:
                    logger.info("[Session %s] Interview duration limit reached (%d minutes), forcing end", 
                               self.session_id, self._max_interview_minutes)
                    await self._end_interview("time_limit_reached", can_rejoin=False)
                    break
                    
        except asyncio.CancelledError:
            logger.debug("[Session %s] Duration monitoring task cancelled", self.session_id)
        except Exception as e:
            logger.error("[Session %s] Error in duration monitoring: %s", self.session_id, str(e))
    
    async def _end_interview(self, reason: str = "unknown", can_rejoin: bool = False):
        """End the interview session"""
        if not self.is_active:
            return
        
        logger.info("[Session %s] Ending interview: reason=%s can_rejoin=%s", self.session_id, reason, can_rejoin)
        
        # Update session status in storage
        sessions_service = get_sessions_service()
        try:
            if can_rejoin:
                # Network drop - mark as dropped, can rejoin
                await sessions_service.mark_dropped(self.session_id, reason=reason)
            else:
                # Explicit end - mark as ended, cannot rejoin
                await sessions_service.end_session(self.session_id, reason=reason, can_rejoin=False)
        except Exception as e:
            logger.error("[Session %s] Failed to update session status: %s", self.session_id, str(e))
        
        try:
            await self.websocket.send_json({
                "type": "interview_ended",
                "message": f"Interview ended: {reason}",
                "reason": reason,
                "canRejoin": can_rejoin,
                "timestamp": time.time()
            })
        except Exception as e:
            logger.warning("[Session %s] Failed to send end notification: %s", self.session_id, str(e))
        
        self.is_active = False
        
        # Cancel duration monitoring task
        if self._duration_check_task and not self._duration_check_task.done():
            self._duration_check_task.cancel()
            try:
                await self._duration_check_task
            except asyncio.CancelledError:
                pass
        
        # Cleanup bridge
        if self.bridge:
            await self.bridge.cleanup()
    
    async def cleanup(self):
        """Clean up the session"""
        self.is_active = False
        
        # Cancel duration monitoring task
        if self._duration_check_task and not self._duration_check_task.done():
            self._duration_check_task.cancel()
            try:
                await self._duration_check_task
            except asyncio.CancelledError:
                pass
        
        if self.bridge:
            await self.bridge.cleanup()
        
        # Clear session config
        clear_session_config(self.session_id)
        
        logger.info("[Session %s] Session cleaned up", self.session_id)


# Global session management
active_sessions: Dict[str, IntegratedVoiceSession] = {}


async def handle_integrated_voice_websocket(websocket: WebSocket, session_id: str):
    """Handle the integrated voice WebSocket connection"""
    await websocket.accept()
    
    logger.info("[Session %s] New integrated voice connection", session_id)
    
    # Create session
    session = IntegratedVoiceSession(session_id, websocket)
    active_sessions[session_id] = session
    
    # Register with cleanup service
    cleanup_service.register_session(session_id)
    
    try:
        # Initialize the voice conversation
        if not await session.initialize():
            logger.error("[Session %s] Failed to initialize", session_id)
            return
        
        # Main message loop
        while session.is_active:
            try:
                message = await websocket.receive()
                
                if "bytes" in message:
                    # Audio data from Jitsi
                    audio_data = message["bytes"]
                    
                    # Update activity for timeout tracking
                    cleanup_service.update_session_activity(session_id)
                    
                    # Update last activity in session storage
                    sessions_service = get_sessions_service()
                    try:
                        import time as time_module
                        await sessions_service.update_session(
                            session_id,
                            last_activity=time_module.time(),
                        )
                    except Exception as e:
                        logger.debug("[Session %s] Failed to update last activity: %s", session_id, str(e))
                    
                    await session.process_audio(audio_data)
                    
                elif "text" in message:
                    # JSON message
                    try:
                        data = json.loads(message["text"])
                        message_type = data.get("type")
                        
                        if message_type == "ping":
                            await websocket.send_json({"type": "pong"})
                        elif message_type == "stop":
                            # Explicit stop - end interview, cannot rejoin
                            await session._end_interview("user_stopped", can_rejoin=False)
                            break
                        elif message_type == "status":
                            await websocket.send_json({
                                "type": "status",
                                "active": session.is_active,
                                "timestamp": time.time()
                            })
                        elif message_type == "force_start":
                            if session.bridge and not session.bridge.has_started():
                                ok = await session.bridge.start_conversation()
                                if ok:
                                    session._interview_start_time = time.time()
                                    # Start duration monitoring task if max minutes is set
                                    if session._max_interview_minutes and not session._duration_check_task:
                                        session._duration_check_task = asyncio.create_task(session._monitor_interview_duration())
                                await websocket.send_json({
                                    "type": "status",
                                    "message": "Conversation started (force)",
                                    "status": "started" if ok else "error",
                                    "started": ok,
                                    "reason": "force",
                                    "max_minutes": session._max_interview_minutes
                                })
                                logger.info("[Session %s] Force start requested -> %s", session_id, 'OK' if ok else 'FAILED')
                            
                    except json.JSONDecodeError:
                        logger.warning("[Session %s] Invalid JSON received", session_id)
                elif "type" in message and message["type"] == "websocket.disconnect":
                    logger.info("[Session %s] WebSocket disconnect message received", session_id)
                    break
                        
            except WebSocketDisconnect:
                logger.info("[Session %s] WebSocket disconnected", session_id)
                # Mark as dropped (network issue), can potentially rejoin
                sessions_service = get_sessions_service()
                try:
                    await sessions_service.mark_dropped(session_id, reason="websocket_disconnect")
                except Exception as e:
                    logger.warning("[Session %s] Failed to mark as dropped: %s", session_id, str(e))
                break
            except RuntimeError as e:
                # Handle case where receive() is called after disconnect
                if "disconnect" in str(e).lower():
                    logger.info("[Session %s] WebSocket disconnected (RuntimeError): %s", session_id, str(e))
                    # Mark as dropped (network issue), can potentially rejoin
                    sessions_service = get_sessions_service()
                    try:
                        await sessions_service.mark_dropped(session_id, reason="websocket_error")
                    except Exception as e2:
                        logger.warning("[Session %s] Failed to mark as dropped: %s", session_id, str(e2))
                    break
                else:
                    logger.error("[Session %s] RuntimeError in message loop: %s", session_id, str(e), exc_info=True)
                    break
            except Exception as e:
                logger.error("[Session %s] Error in message loop: %s", session_id, str(e), exc_info=True)
                break
                
    except Exception as e:
        logger.error("[Session %s] Session error: %s", session_id, str(e), exc_info=True)
    finally:
        # Cleanup
        await session.cleanup()
        if session_id in active_sessions:
            del active_sessions[session_id]
        
        # Unregister from cleanup service
        cleanup_service.unregister_session(session_id)
        
        logger.info("[Session %s] Session ended", session_id)


# FastAPI WebSocket endpoint (to be added to main.py)
async def integrated_voice_endpoint(websocket: WebSocket, session_id: str):
    """FastAPI WebSocket endpoint for integrated voice conversations"""
    await handle_integrated_voice_websocket(websocket, session_id)


# Utility functions for integration
def get_active_session_count() -> int:
    """Get number of active voice sessions"""
    return len(active_sessions)


def get_session_status(session_id: str) -> Optional[dict]:
    """Get status of a specific session"""
    if session_id in active_sessions:
        session = active_sessions[session_id]
        return {
            "active": session.is_active,
            "ready": session.bridge.is_ready() if session.bridge else False
        }
    return None
