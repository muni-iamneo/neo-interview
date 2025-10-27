"""
FastAPI Backend with Integrated ElevenLabs Voice Conversation
============================================================

This backend provides:
1. JaaS JWT authentication for Jitsi meetings
2. Direct voice conversation with ElevenLabs agents via WebSocket
3. Real-time audio streaming without requiring AssemblyAI transcription
"""

from fastapi import FastAPI, WebSocket
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.backends import default_backend
import time
from typing import Optional
from contextlib import asynccontextmanager

# Import configuration and logging
from app.core.config import get_settings
from app.core.logging_config import get_logger

# Import services
from app.services.cleanup_service import get_cleanup_service
from app.services.voice_endpoint import integrated_voice_endpoint, get_active_session_count, get_session_status

# Initialize settings, logger, and services
settings = get_settings()
logger = get_logger(__name__)
cleanup_service = get_cleanup_service()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Manage application startup and shutdown"""
    # Startup
    logger.info("Application starting up...")
    await cleanup_service.start()
    logger.info("Application initialized successfully")
    yield
    # Shutdown
    logger.info("Application shutting down...")
    await cleanup_service.stop()
    logger.info("Application shutdown complete")


app = FastAPI(
    title="Jitsi-ElevenLabs Voice Agent",
    description="Real-time voice conversation system",
    version="1.0.0",
    lifespan=lifespan
)

# CORS middleware with configuration
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def get_private_key() -> Optional[any]:
    """Load private key from file or environment variable"""
    # Try loading from file first
    if settings.JAA_PRIVATE_KEY_FILE:
        try:
            with open(settings.JAA_PRIVATE_KEY_FILE, "rb") as f:
                key = serialization.load_pem_private_key(
                    f.read(), password=None, backend=default_backend()
                )
                logger.info("Private key loaded from file")
                return key
        except FileNotFoundError:
            logger.error("Private key file not found: %s", settings.JAA_PRIVATE_KEY_FILE)
            return None
        except Exception as e:
            logger.error("Failed to load private key from file: %s", str(e))
            return None
    
    # Try loading from environment variable
    if settings.JAA_PRIVATE_KEY:
        try:
            normalized_pem = settings.JAA_PRIVATE_KEY.replace("\\n", "\n").encode()
            key = serialization.load_pem_private_key(
                normalized_pem, password=None, backend=default_backend()
            )
            logger.info("Private key loaded from environment")
            return key
        except Exception as e:
            logger.error("Failed to load private key from environment: %s", str(e))
            return None
    
    logger.error("No private key configured")
    return None


# POST /jaas/jwt
@app.post("/jaas/jwt")
async def mint_jwt(body: dict):
    """Mint a JaaS JWT token for Jitsi meeting authentication"""
    # Validate required fields
    required = ["room", "user"]
    for key in required:
        if key not in body:
            logger.warning("Missing required field: %s", key)
            return JSONResponse({"error": f"Missing field: {key}"}, status_code=400)

    # Get effective tenant
    effective_tenant = settings.get_effective_tenant()

    # Validate configuration
    if not all([settings.JAA_APP_ID, effective_tenant, settings.JAA_PUBLIC_KEY_ID]):
        logger.error("Missing JaaS configuration")
        return JSONResponse(
            {"error": "Server configuration error: Missing JaaS credentials"},
            status_code=500,
        )

    # Load private key
    private_key = get_private_key()
    if private_key is None:
        logger.error("Private key not available")
        return JSONResponse(
            {"error": "Server configuration error: Invalid or missing private key"},
            status_code=500
        )

    room = body["room"]
    user = body["user"]
    features = body.get("features", {"transcription": True})
    ttl_sec = min(int(body.get("ttlSec", settings.JWT_DEFAULT_TTL_SECONDS)), settings.JWT_MAX_TTL_SECONDS)

    logger.info("Minting JWT for room: %s, user: %s", room, user.get("name", "unknown"))

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

    try:
        jwt_token = jwt.encode(
            claims,
            private_key,
            algorithm="RS256",
            headers={"kid": settings.JAA_PUBLIC_KEY_ID},
        )
        
        logger.info("JWT minted successfully for room: %s/%s", effective_tenant, room)
        
        return JSONResponse(
            {"domain": settings.JAA_EMBED_DOMAIN, "room": f"{effective_tenant}/{room}", "jwt": jwt_token}
        )
    except Exception as e:
        logger.error("JWT signing failed: %s", str(e), exc_info=True)
        return JSONResponse(
            {"error": f"Failed to sign JWT: {str(e)}"},
            status_code=500
        )


# NEW: Integrated voice conversation endpoint
@app.websocket("/agent/{sessionId}/voice")
async def integrated_voice(websocket: WebSocket, sessionId: str):
    """Real-time voice conversation with ElevenLabs agent"""
    logger.info("Voice WebSocket connection request for session: %s", sessionId)
    try:
        await integrated_voice_endpoint(websocket, sessionId)
    except Exception as e:
        logger.error("Voice endpoint error for session %s: %s", sessionId, str(e), exc_info=True)
        try:
            await websocket.close(code=1011, reason="Internal error")
        except:
            pass


# Status endpoint for voice sessions
@app.get("/voice/sessions")
async def get_voice_sessions():
    """Get status of all active voice sessions"""
    active_count = get_active_session_count()
    logger.debug("Voice sessions status requested: %d active", active_count)
    return {
        "active_sessions": active_count,
        "timestamp": time.time()
    }


@app.get("/voice/sessions/{session_id}")
async def get_voice_session_status(session_id: str):
    """Get status of a specific voice session"""
    logger.debug("Session status requested: %s", session_id)
    status = get_session_status(session_id)
    if status is None:
        logger.warning("Session not found: %s", session_id)
        return JSONResponse({"error": "Session not found"}, status_code=404)
    return status


@app.get("/health")
async def health_check():
    """Health check endpoint"""
    return {
        "status": "healthy",
        "timestamp": time.time(),
        "version": "1.0.0"
    }


if __name__ == "__main__":
    import uvicorn

    logger.info("Starting server on %s:%d", settings.HOST, settings.PORT)
    uvicorn.run(
        app,
        host=settings.HOST,
        port=settings.PORT,
        log_level=settings.LOG_LEVEL.lower()
    )

