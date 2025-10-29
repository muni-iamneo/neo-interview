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

# Import API routers
from app.api.agents_router import router as agents_router
from app.api.session_router import router as session_router

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

# Include API routers
app.include_router(agents_router)
app.include_router(session_router)


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
    
    # Check if this is a rejoin request
    session_id = body.get("sessionId")
    is_rejoin = body.get("rejoin", False)
    
    if is_rejoin and session_id:
        from app.services.sessions_service import get_sessions_service
        sessions_service = get_sessions_service()
        session = await sessions_service.get_session(session_id)
        
        if not session:
            return JSONResponse({"error": f"Session {session_id} not found"}, status_code=404)
        
        if not session.can_rejoin:
            return JSONResponse({"error": "Session cannot be rejoined"}, status_code=403)
        
        if session.status.value not in ["dropped", "paused"]:
            return JSONResponse({"error": f"Session status {session.status.value} does not allow rejoin"}, status_code=403)
        
        # Check if JWT is still valid
        if session.jwt_expiry and time.time() > session.jwt_expiry:
            # JWT expired, need to mint new one but keep same meeting
            logger.info("JWT expired for session %s, minting new token", session_id)
            room = session.meeting_id.split('/')[-1] if '/' in session.meeting_id else session.meeting_id
            
            # Recalculate TTL based on interview duration if available
            if session.max_interview_minutes:
                calculated_ttl = (session.max_interview_minutes + 5) * 60  # Interview duration + 5 min buffer
                body["ttlSec"] = calculated_ttl  # Set in body so it's picked up below
                logger.info("Using interview-based TTL for rejoin: %d minutes = %d seconds", 
                           session.max_interview_minutes + 5, calculated_ttl)
        else:
            # Use existing JWT
            logger.info("Using existing JWT for rejoining session %s", session_id)
            return JSONResponse({
                "domain": settings.JAA_EMBED_DOMAIN,
                "room": session.meeting_id,
                "jwt": session.jwt_token,
                "rejoin": True
            })
    
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
    
    # Calculate TTL: use provided ttlSec, or calculate from session config if available
    provided_ttl = body.get("ttlSec")
    if provided_ttl is not None:
        ttl_sec = min(int(provided_ttl), settings.JWT_MAX_TTL_SECONDS)
    elif session_id:
        # Try to get interview duration from session config
        from app.services.session_config import get_session_config
        session_config = get_session_config(session_id)
        if session_config and session_config.max_interview_minutes:
            ttl_sec = (session_config.max_interview_minutes + 5) * 60  # Interview duration + 5 min buffer
            logger.info("Calculated JWT TTL from interview duration: %d minutes + 5 min buffer = %d seconds",
                       session_config.max_interview_minutes, ttl_sec)
            ttl_sec = min(ttl_sec, settings.JWT_MAX_TTL_SECONDS)
        else:
            ttl_sec = min(settings.JWT_DEFAULT_TTL_SECONDS, settings.JWT_MAX_TTL_SECONDS)
    else:
        ttl_sec = min(settings.JWT_DEFAULT_TTL_SECONDS, settings.JWT_MAX_TTL_SECONDS)

    logger.info("Minting JWT for room: %s, user: %s, TTL: %d seconds", 
                room, user.get("name", "unknown"), ttl_sec)

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
        
        full_room = f"{effective_tenant}/{room}"
        
        # Store session if session_id provided
        if session_id:
            from app.services.sessions_service import get_sessions_service
            sessions_service = get_sessions_service()
            
            # Get session config to extract agent info
            from app.services.session_config import get_session_config
            session_config = get_session_config(session_id)
            
            if session_config:
                # Get agent ID from storage
                from app.services.agents_service import get_agents_service
                agents_service = get_agents_service()
                
                # Find agent by eleven_agent_id
                all_agents = await agents_service.list_agents()
                agent = None
                for a in all_agents:
                    if a.eleven_agent_id == session_config.eleven_agent_id:
                        agent = a
                        break
                
                if agent:
                    await sessions_service.create_session(
                        session_id=session_id,
                        meeting_id=full_room,
                        agent_id=agent.id,
                        eleven_agent_id=session_config.eleven_agent_id,
                        jwt_token=jwt_token,
                        jwt_expiry=now + ttl_sec,
                        max_interview_minutes=session_config.max_interview_minutes,
                        dynamic_variables=session_config.dynamic_variables,
                    )
                    logger.info("Session stored: %s (meeting: %s)", session_id, full_room)
        
        return JSONResponse(
            {"domain": settings.JAA_EMBED_DOMAIN, "room": full_room, "jwt": jwt_token}
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

