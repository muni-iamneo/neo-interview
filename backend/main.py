"""
FastAPI Backend with Integrated ElevenLabs Voice Conversation
============================================================

This backend provides:
1. JaaS JWT authentication for Jitsi meetings
2. Direct voice conversation with ElevenLabs agents via WebSocket
3. Real-time audio streaming without requiring AssemblyAI transcription

The new voice system replaces the old AssemblyAI + ElevenLabs chain with
direct WebSocket communication to ElevenLabs for lower latency and better
voice quality.
"""

from fastapi import FastAPI, WebSocket
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.backends import default_backend
import os
from dotenv import load_dotenv
import time
from typing import Any, Dict, Optional

# Import integrated voice handler for direct ElevenLabs conversation
from integrated_voice_endpoint import integrated_voice_endpoint, get_active_session_count, get_session_status


load_dotenv()

app = FastAPI()

# CORS for frontend (localhost:4200)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:4200", "http://localhost:4300"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Secrets (loaded from env)
JAA_APP_ID = os.getenv("JAA_APP_ID")
JAA_TENANT = os.getenv("JAA_TENANT")
JAA_PUBLIC_KEY_ID = os.getenv("JAA_PUBLIC_KEY_ID")
ELEVENLABS_API_KEY = os.getenv("ELEVENLABS_API_KEY")
ELEVENLABS_AGENT_ID = os.getenv("ELEVENLABS_AGENT_ID")
JAA_EMBED_DOMAIN = os.getenv("JAA_EMBED_DOMAIN", "8x8.vc")


def get_private_key() -> Optional[Any]:
    # First, allow loading from a file path if provided
    pem_file = os.getenv("JAA_PRIVATE_KEY_FILE")
    if pem_file and os.path.isfile(pem_file):
        try:
            with open(pem_file, "rb") as f:
                return serialization.load_pem_private_key(
                    f.read(), password=None, backend=default_backend()
                )
        except Exception:
            return None

    # Else, read from env var; support literal "\n" escaped newlines
    pem = os.getenv("JAA_PRIVATE_KEY")
    if not pem:
        return None
    # Replace two-character sequence backslash+n with real newline
    normalized_pem = pem.replace("\\n", "\n").encode()
    try:
        return serialization.load_pem_private_key(
            normalized_pem, password=None, backend=default_backend()
        )
    except Exception:
        return None


# POST /jaas/jwt
@app.post("/jaas/jwt")
async def mint_jwt(body: Dict[str, Any]):
    required = ["room", "user"]
    for key in required:
        if key not in body:
            return JSONResponse({"error": f"Missing field: {key}"}, status_code=400)

    # In JaaS, iss and sub should be the AppID/tenant (same slug). If tenant is omitted,
    # fall back to AppID to reduce setup friction.
    effective_tenant = JAA_TENANT or JAA_APP_ID

    if not (JAA_APP_ID and effective_tenant and JAA_PUBLIC_KEY_ID):
        return JSONResponse(
            {"error": "Missing JaaS configuration in environment (.env)"},
            status_code=500,
        )

    private_key = get_private_key()
    if private_key is None:
        return JSONResponse(
            {"error": "Invalid or missing JAA_PRIVATE_KEY in .env"}, status_code=500
        )

    room = body["room"]
    user = body["user"]
    features = body.get("features", {"transcription": True})
    ttl_sec = int(body.get("ttlSec", 3600))

    now = int(time.time())
    claims = {
        "iss": "chat",
        "sub": effective_tenant,
        "aud": "jitsi",
        "room": room,
        "exp": now + ttl_sec,
        "nbf": now,
        "context": {"user": user, "features": features},
    }

    jwt_token = jwt.encode(
        claims,
        private_key,
        algorithm="RS256",
        headers={"kid": JAA_PUBLIC_KEY_ID},
    )
    return JSONResponse(
        {"domain": JAA_EMBED_DOMAIN, "room": f"{effective_tenant}/{room}", "jwt": jwt_token}
    )


# NEW: Integrated voice conversation endpoint (replaces AssemblyAI + ElevenLabs chain)
@app.websocket("/agent/{sessionId}/voice")
async def integrated_voice(websocket: WebSocket, sessionId: str):
    """Real-time voice conversation with ElevenLabs agent (no AssemblyAI required)"""
    await integrated_voice_endpoint(websocket, sessionId)


# Status endpoint for voice sessions
@app.get("/voice/sessions")
async def get_voice_sessions():
    """Get status of all active voice sessions"""
    return {
        "active_sessions": get_active_session_count(),
        "timestamp": time.time()
    }


@app.get("/voice/sessions/{session_id}")
async def get_voice_session_status(session_id: str):
    """Get status of a specific voice session"""
    status = get_session_status(session_id)
    if status is None:
        return {"error": "Session not found"}
    return status


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)

