#!/usr/bin/env python3
"""
Integrated Voice Endpoint for Jitsi + ElevenLabs
Replaces AssemblyAI transcription with direct voice conversation
"""

import asyncio
import json
import base64
import time
from typing import Dict, Optional
from fastapi import WebSocket, WebSocketDisconnect
import os
from dotenv import load_dotenv

# Import our voice handler
from elevenlabs_voice_handler import JitsiElevenLabsBridge

load_dotenv()

class IntegratedVoiceSession:
    """Manages a single voice conversation session"""

    def __init__(self, session_id: str, websocket: WebSocket):
        self.session_id = session_id
        self.websocket = websocket
        self.bridge: Optional[JitsiElevenLabsBridge] = None
        self.is_active = False
        self.audio_buffer = bytearray()
        self.chunk_size = 1024  # Audio chunk size in bytes
        # VAD tracking before conversation start
        self._pre_start_chunks = 0
        self._rms_accum = 0.0
        self._rms_samples = 0
        
    async def initialize(self):
        """Initialize the voice conversation"""
        try:
            api_key = os.getenv("ELEVENLABS_API_KEY")
            agent_id = os.getenv("ELEVENLABS_AGENT_ID")
            
            if not api_key or not agent_id:
                await self.websocket.send_json({
                    "type": "error",
                    "message": "Missing ElevenLabs configuration"
                })
                return False
            
            # Create bridge
            self.bridge = JitsiElevenLabsBridge(api_key, agent_id)
            
            # Register callbacks
            self.bridge.register_audio_callback(self._on_audio_response)
            self.bridge.register_text_callback(self._on_text_response)
            self.bridge.register_error_callback(self._on_error)
            
            # Initialize
            if not await self.bridge.initialize():
                await self.websocket.send_json({
                    "type": "error",
                    "message": "Failed to connect to ElevenLabs"
                })
                return False
            
            # Do NOT start conversation yet. We now wait for real speech (VAD) before
            # calling start_conversation() to avoid unsolicited greeting.
            self.is_active = True
            await self.websocket.send_json({
                "type": "status",
                "message": "Voice bridge connected (waiting for speech)",
                "status": "connected",
                "started": False
            })

            print(f"[Session {self.session_id}] Voice bridge ready (awaiting speech to start agent)")
            return True
            
        except Exception as e:
            print(f"[Session {self.session_id}] Initialization error: {e}")
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
            # Debug size (first 5 pre-start chunks & then every 20 after start)
            if not self.bridge.has_started():
                if self._pre_start_chunks < 5:
                    print(f"[Session {self.session_id}] Incoming pre-start audio chunk {self._pre_start_chunks+1} size={len(audio_data)} bytes")
            else:
                if self._pre_start_chunks % 20 == 0:
                    print(f"[Session {self.session_id}] Ongoing audio chunk size={len(audio_data)} bytes")
            # If conversation not started, run cheap VAD on this chunk.
            if not self.bridge.has_started():
                speech, rms = self._is_speech(audio_data, return_rms=True)
                self._pre_start_chunks += 1
                # Accumulate RMS for fallback decision
                self._rms_accum += rms
                self._rms_samples += 1
                avg_rms = self._rms_accum / self._rms_samples if self._rms_samples else 0
                debug_every = 10
                if self._pre_start_chunks % debug_every == 0:
                    print(f"[Session {self.session_id}] Pre-start VAD debug: chunks={self._pre_start_chunks} last_rms={rms:.4f} avg_rms={avg_rms:.4f}")

                # Conditions to start conversation:
                # 1. Detected speech on a chunk OR
                # 2. Received >=25 chunks (~500ms+) and average RMS above very low floor OR
                # 3. Safety auto-start after 60 chunks (~1.2s) regardless
                if speech or (self._pre_start_chunks >= 25 and avg_rms > 0.003) or self._pre_start_chunks >= 60:
                    ok = await self.bridge.start_conversation()
                    if ok:
                        await self.websocket.send_json({
                            "type": "status",
                            "message": "Conversation started (VAD/auto)",
                            "status": "started",
                            "started": True,
                            "reason": "speech" if speech else ("avg_rms" if avg_rms > 0.003 else "timeout")
                        })
                        print(f"[Session {self.session_id}] Agent conversation started reason={ 'speech' if speech else ('avg_rms' if avg_rms > 0.003 else 'timeout')} rms={rms:.4f} avg={avg_rms:.4f}")
                if not self.bridge.has_started():
                    return  # still waiting
            # Conversation active: forward audio
            await self.bridge.process_audio_chunk(audio_data)
            
            # Log the audio processing for debugging
            print(f"[Session {self.session_id}] Processed audio: {len(audio_data)} bytes")
            
        except Exception as e:
            print(f"[Session {self.session_id}] Audio processing error: {e}")
    
    async def _on_audio_response(self, audio_data: bytes):
        """Handle audio response from ElevenLabs agent"""
        try:
            # Send audio response back to Jitsi
            await self.websocket.send_bytes(audio_data)
            
            # Also send a text notification
            await self.websocket.send_json({
                "type": "audio_response",
                "size": len(audio_data),
                "timestamp": time.time()
            })
            
        except Exception as e:
            print(f"[Session {self.session_id}] Error sending audio response: {e}")
    
    async def _on_text_response(self, text: str):
        """Handle text response from ElevenLabs agent"""
        try:
            await self.websocket.send_json({
                "type": "text_response",
                "text": text,
                "timestamp": time.time()
            })
        except Exception as e:
            print(f"[Session {self.session_id}] Error sending text response: {e}")

    def _is_speech(self, pcm16: bytes, return_rms: bool = False):
        """Simple energy-based VAD with optional RMS return.

        Returns (bool, rms) if return_rms else bool.
        Threshold tuned lower for downsampled meeting audio.
        """
        if not pcm16:
            return (False, 0.0) if return_rms else False

        sample_count = len(pcm16) // 2
        if sample_count == 0:
            return (False, 0.0) if return_rms else False

        import math
        total = 0.0
        step = 4  # stride over samples to reduce work
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
        # Lower threshold for remote meeting audio that may be quieter after downsampling.
        # If false positives occur, raise to ~0.005-0.006.
        threshold = 0.0005
        is_speech = rms > threshold
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
            print(f"[Session {self.session_id}] Error sending error message: {e}")
    
    async def cleanup(self):
        """Clean up the session"""
        self.is_active = False
        if self.bridge:
            await self.bridge.cleanup()
        print(f"[Session {self.session_id}] Session cleaned up")


# Global session management
active_sessions: Dict[str, IntegratedVoiceSession] = {}


async def handle_integrated_voice_websocket(websocket: WebSocket, session_id: str):
    """Handle the integrated voice WebSocket connection"""
    await websocket.accept()
    
    print(f"[Session {session_id}] New integrated voice connection")
    
    # Create session
    session = IntegratedVoiceSession(session_id, websocket)
    active_sessions[session_id] = session
    
    try:
        # Initialize the voice conversation
        if not await session.initialize():
            print(f"[Session {session_id}] Failed to initialize")
            return
        
        # Main message loop
        while session.is_active:
            try:
                # Receive message (could be audio bytes or JSON)
                message = await websocket.receive()
                
                if "bytes" in message:
                    # Audio data from Jitsi
                    audio_data = message["bytes"]
                    print(f"[Session {session_id}] Received audio from frontend: {len(audio_data)} bytes")
                    # Log the first few audio chunks for debugging
                    if session._pre_start_chunks < 5:
                        print(f"[Session {session_id}] Received audio chunk: {len(audio_data)} bytes")
                    
                    # Process the audio data
                    await session.process_audio(audio_data)
                    
                elif "text" in message:
                    # JSON message
                    try:
                        data = json.loads(message["text"])
                        message_type = data.get("type")
                        
                        if message_type == "ping":
                            # Keep alive
                            await websocket.send_json({"type": "pong"})
                        elif message_type == "stop":
                            # Stop conversation
                            session.is_active = False
                            break
                        elif message_type == "status":
                            # Status request
                            await websocket.send_json({
                                "type": "status",
                                "active": session.is_active,
                                "timestamp": time.time()
                            })
                        elif message_type == "force_start":
                            if session.bridge and not session.bridge.has_started():
                                ok = await session.bridge.start_conversation()
                                await websocket.send_json({
                                    "type": "status",
                                    "message": "Conversation started (force)",
                                    "status": "started" if ok else "error",
                                    "started": ok,
                                    "reason": "force"
                                })
                                print(f"[Session {session_id}] Force start requested -> {'OK' if ok else 'FAILED'}")
                            
                    except json.JSONDecodeError:
                        print(f"[Session {session_id}] Invalid JSON received")
                        
            except WebSocketDisconnect:
                print(f"[Session {session_id}] WebSocket disconnected")
                break
            except Exception as e:
                print(f"[Session {session_id}] Error in message loop: {e}")
                break
                
    except Exception as e:
        print(f"[Session {session_id}] Session error: {e}")
    finally:
        # Cleanup
        await session.cleanup()
        if session_id in active_sessions:
            del active_sessions[session_id]
        print(f"[Session {session_id}] Session ended")


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


async def stop_session(session_id: str):
    """Stop a specific session"""
    if session_id in active_sessions:
        session = active_sessions[session_id]
        await session.cleanup()
        del active_sessions[session_id]
        return True
    return False


async def stop_all_sessions():
    """Stop all active sessions"""
    for session_id in list(active_sessions.keys()):
        await stop_session(session_id)


# Example usage and testing
async def test_integration():
    """Test the integration without FastAPI"""
    print("Testing ElevenLabs Voice Integration...")
    
    # Test bridge creation
    api_key = os.getenv("ELEVENLABS_API_KEY")
    agent_id = os.getenv("ELEVENLABS_AGENT_ID")
    
    if not api_key or not agent_id:
        print("Missing environment variables")
        return
    
    bridge = JitsiElevenLabsBridge(api_key, agent_id)
    
    # Initialize
    if not await bridge.initialize():
        print("Failed to initialize bridge")
        return
    
    # Register callbacks
    def on_audio(audio_data):
        print(f"Audio response: {len(audio_data)} bytes")
    
    def on_text(text):
        print(f"Text response: {text}")
    
    def on_error(error):
        print(f"Error: {error}")
    
    bridge.register_audio_callback(on_audio)
    bridge.register_text_callback(on_text)
    bridge.register_error_callback(on_error)
    
    # Start conversation
    await bridge.start_conversation()
    
    print("Integration test completed successfully")
    await bridge.cleanup()


if __name__ == "__main__":
    asyncio.run(test_integration())
