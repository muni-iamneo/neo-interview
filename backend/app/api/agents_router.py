"""
Agents API Router
RESTful endpoints for agent management
"""

from typing import List, Optional
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..services.agents_service import get_agents_service
from ..core.logging_config import get_logger

logger = get_logger(__name__)
router = APIRouter(prefix="/api/agents", tags=["agents"])


class CreateAgentRequest(BaseModel):
    """Request model for creating an agent"""
    name: str = Field(..., min_length=1, max_length=100, description="Agent name (e.g., 'Senior Developer Interviewer')")
    role: str = Field(..., min_length=1, max_length=200, description="Role being interviewed for (e.g., 'Senior Backend Engineer')")
    maxInterviewMinutes: int = Field(..., ge=5, le=180, description="Max interview duration in minutes")
    jobDescription: str = Field(..., min_length=1, max_length=5000, description="Job description for the position being interviewed for")
    interviewType: str = Field(default="technical", description="Type of interview: technical, system_design, behavioral, managerial, hr, product, panel, case_study")
    systemPrompt: Optional[str] = Field(None, max_length=10000, description="Optional custom system prompt for the agent")


class UpdateAgentRequest(BaseModel):
    """Request model for updating an agent"""
    name: Optional[str] = Field(None, min_length=1, max_length=100, description="Agent name")
    role: Optional[str] = Field(None, min_length=1, max_length=200, description="Role being interviewed for")
    maxInterviewMinutes: Optional[int] = Field(None, ge=5, le=180, description="Max interview duration in minutes")
    jobDescription: Optional[str] = Field(None, min_length=1, max_length=5000, description="Job description for the position")
    interviewType: Optional[str] = Field(None, description="Type of interview: technical, system_design, behavioral, managerial, hr, product, panel, case_study")
    systemPrompt: Optional[str] = Field(None, max_length=10000, description="Optional custom system prompt for the agent")


class AgentResponse(BaseModel):
    """Response model for agent data"""
    id: str
    name: str
    role: str
    maxInterviewMinutes: int
    jobDescription: str
    interviewType: str
    systemPrompt: Optional[str]
    elevenAgentId: Optional[str]
    createdAt: str
    updatedAt: str


@router.post("", response_model=AgentResponse, status_code=201)
async def create_agent(request: CreateAgentRequest):
    """Create a new agent"""
    try:
        logger.info("Creating agent: %s", request.name)
        
        service = get_agents_service()
        agent = await service.create_agent(
            name=request.name,
            role=request.role,
            max_interview_minutes=request.maxInterviewMinutes,
            job_description=request.jobDescription,
            interview_type=request.interviewType,
            system_prompt=request.systemPrompt,
        )
        
        return AgentResponse(**agent.to_dict())
        
    except ValueError as e:
        logger.warning("Validation error creating agent: %s", str(e))
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error("Failed to create agent: %s", str(e), exc_info=True)
        raise HTTPException(status_code=500, detail="Internal server error")


@router.get("", response_model=List[AgentResponse])
async def list_agents():
    """List all agents"""
    try:
        service = get_agents_service()
        agents = await service.list_agents()
        return [AgentResponse(**agent.to_dict()) for agent in agents]
    except Exception as e:
        logger.error("Failed to list agents: %s", str(e), exc_info=True)
        raise HTTPException(status_code=500, detail="Internal server error")


@router.get("/{agent_id}", response_model=AgentResponse)
async def get_agent(agent_id: str):
    """Get a single agent by ID"""
    try:
        service = get_agents_service()
        agent = await service.get_agent(agent_id)
        
        if not agent:
            raise HTTPException(status_code=404, detail="Agent not found")
        
        return AgentResponse(**agent.to_dict())
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Failed to get agent: %s", str(e), exc_info=True)
        raise HTTPException(status_code=500, detail="Internal server error")


@router.put("/{agent_id}", response_model=AgentResponse)
async def update_agent(agent_id: str, request: UpdateAgentRequest):
    """Update an existing agent"""
    try:
        logger.info("Updating agent: %s", agent_id)
        
        service = get_agents_service()
        agent = await service.update_agent(
            agent_id=agent_id,
            name=request.name,
            role=request.role,
            max_interview_minutes=request.maxInterviewMinutes,
            job_description=request.jobDescription,
            interview_type=request.interviewType,
            system_prompt=request.systemPrompt,
        )
        
        return AgentResponse(**agent.to_dict())
        
    except ValueError as e:
        logger.warning("Validation error updating agent: %s", str(e))
        
        if "not found" in str(e).lower():
            raise HTTPException(status_code=404, detail=str(e))
        
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error("Failed to update agent: %s", str(e), exc_info=True)
        raise HTTPException(status_code=500, detail="Internal server error")


@router.delete("/{agent_id}", status_code=204)
async def delete_agent(agent_id: str):
    """Delete an agent"""
    try:
        service = get_agents_service()
        deleted = await service.delete_agent(agent_id)
        
        if not deleted:
            raise HTTPException(status_code=404, detail="Agent not found")
        
        return None
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Failed to delete agent: %s", str(e), exc_info=True)
        raise HTTPException(status_code=500, detail="Internal server error")

