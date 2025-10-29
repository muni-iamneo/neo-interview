"""
Redis Service
Provides Redis connection and helper methods for storage
"""

import json
from typing import Optional, Dict, List, Any
from redis.asyncio import Redis
import redis.asyncio as redis

from ..core.config import get_settings
from ..core.logging_config import get_logger

settings = get_settings()
logger = get_logger(__name__)

# Global Redis client instance
_redis_client: Optional[Redis] = None


def get_redis_url() -> Optional[str]:
    """Get Redis URL from settings (prefer CACHE_BACKEND_URL, fallback to CELERY_BROKER_URL)"""
    return settings.CACHE_BACKEND_URL or settings.CELERY_BROKER_URL


async def get_redis_client() -> Optional[Redis]:
    """Get or create Redis client instance"""
    global _redis_client
    
    redis_url = get_redis_url()
    if not redis_url:
        logger.warning("No Redis URL configured (CACHE_BACKEND_URL or CELERY_BROKER_URL)")
        return None
    
    if _redis_client is None:
        try:
            _redis_client = redis.from_url(
                redis_url,
                encoding="utf-8",
                decode_responses=True,
                health_check_interval=30
            )
            # Test connection
            await _redis_client.ping()
            logger.info("Connected to Redis at %s", redis_url.split("@")[-1] if "@" in redis_url else redis_url)
        except Exception as e:
            logger.error("Failed to connect to Redis: %s", str(e), exc_info=True)
            _redis_client = None
    
    return _redis_client


async def close_redis_client():
    """Close Redis client connection"""
    global _redis_client
    if _redis_client:
        try:
            await _redis_client.close()
            logger.info("Redis client closed")
        except Exception as e:
            logger.error("Error closing Redis client: %s", str(e))
        finally:
            _redis_client = None


class RedisStorage:
    """Redis storage helper for key-value operations"""
    
    def __init__(self, key_prefix: str = ""):
        self.key_prefix = key_prefix
    
    def _make_key(self, key: str) -> str:
        """Create a namespaced key"""
        return f"{self.key_prefix}:{key}" if self.key_prefix else key
    
    async def get(self, key: str) -> Optional[str]:
        """Get a string value"""
        client = await get_redis_client()
        if not client:
            return None
        try:
            return await client.get(self._make_key(key))
        except Exception as e:
            logger.error("Redis GET error for key %s: %s", key, str(e))
            return None
    
    async def set(self, key: str, value: str, ttl: Optional[int] = None) -> bool:
        """Set a string value with optional TTL"""
        client = await get_redis_client()
        if not client:
            return False
        try:
            if ttl:
                return await client.setex(self._make_key(key), ttl, value)
            else:
                return await client.set(self._make_key(key), value)
        except Exception as e:
            logger.error("Redis SET error for key %s: %s", key, str(e))
            return False
    
    async def delete(self, key: str) -> bool:
        """Delete a key"""
        client = await get_redis_client()
        if not client:
            return False
        try:
            return await client.delete(self._make_key(key)) > 0
        except Exception as e:
            logger.error("Redis DELETE error for key %s: %s", key, str(e))
            return False
    
    async def get_json(self, key: str) -> Optional[Any]:
        """Get and deserialize JSON value"""
        value = await self.get(key)
        if value is None:
            return None
        try:
            return json.loads(value)
        except json.JSONDecodeError as e:
            logger.error("Failed to decode JSON for key %s: %s", key, str(e))
            return None
    
    async def set_json(self, key: str, value: Any, ttl: Optional[int] = None) -> bool:
        """Serialize and set JSON value"""
        try:
            json_str = json.dumps(value)
            return await self.set(key, json_str, ttl)
        except (TypeError, ValueError) as e:
            logger.error("Failed to encode JSON for key %s: %s", key, str(e))
            return False
    
    async def exists(self, key: str) -> bool:
        """Check if key exists"""
        client = await get_redis_client()
        if not client:
            return False
        try:
            return await client.exists(self._make_key(key)) > 0
        except Exception as e:
            logger.error("Redis EXISTS error for key %s: %s", key, str(e))
            return False
    
    async def keys(self, pattern: str = "*") -> List[str]:
        """Get all keys matching pattern"""
        client = await get_redis_client()
        if not client:
            return []
        try:
            full_pattern = f"{self.key_prefix}:{pattern}" if self.key_prefix else pattern
            keys = await client.keys(full_pattern)
            # Remove prefix from keys if present
            if self.key_prefix:
                prefix = f"{self.key_prefix}:"
                keys = [k.replace(prefix, "", 1) if k.startswith(prefix) else k for k in keys]
            return keys
        except Exception as e:
            logger.error("Redis KEYS error for pattern %s: %s", pattern, str(e))
            return []
    
    async def get_all_json(self, pattern: str = "*") -> Dict[str, Any]:
        """Get all JSON values matching pattern"""
        keys = await self.keys(pattern)
        result = {}
        for key in keys:
            value = await self.get_json(key)
            if value is not None:
                result[key] = value
        return result

