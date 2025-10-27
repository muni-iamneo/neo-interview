"""
Centralized Logging Configuration
"""

import logging
import sys
from typing import Optional


def setup_logging(name: Optional[str] = None, level: str = "INFO") -> logging.Logger:
    """
    Setup and configure logging
    
    Args:
        name: Logger name
        level: Log level (DEBUG, INFO, WARNING, ERROR, CRITICAL)
        
    Returns:
        Configured logger
    """
    logger = logging.getLogger(name) if name else logging.getLogger()
    
    if logger.handlers:
        return logger
    
    log_level = getattr(logging, level.upper())
    logger.setLevel(log_level)
    
    handler = logging.StreamHandler(sys.stdout)
    handler.setLevel(log_level)
    
    formatter = logging.Formatter(
        '%(asctime)s - %(name)s - %(levelname)s - %(message)s',
        datefmt='%Y-%m-%d %H:%M:%S'
    )
    handler.setFormatter(formatter)
    
    logger.addHandler(handler)
    logger.propagate = False
    
    return logger


def get_logger(name: str, level: str = "INFO") -> logging.Logger:
    """Get a configured logger"""
    return setup_logging(name, level)

