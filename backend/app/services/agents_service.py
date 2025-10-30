"""
ElevenLabs Agents Service
Manages agent creation, updates, and persistence with ElevenLabs API
Uses Redis for storage
"""

import json
import uuid
import asyncio
from datetime import datetime
from typing import Dict, List, Optional

import httpx
from elevenlabs.client import ElevenLabs

from ..core.config import get_settings
from ..core.logging_config import get_logger
from .redis_service import RedisStorage

settings = get_settings()
logger = get_logger(__name__)


class AgentData:
    """Agent data model"""
    
    def __init__(
        self,
        name: str,
        role: str,
        max_interview_minutes: int,
        job_description: str,
        interview_type: str = "technical",
        system_prompt: Optional[str] = None,
        eleven_agent_id: Optional[str] = None,
        agent_id: Optional[str] = None,
    ):
        self.id = agent_id or str(uuid.uuid4())
        self.name = name
        self.role = role
        self.max_interview_minutes = max_interview_minutes
        self.job_description = job_description
        self.interview_type = interview_type
        self.system_prompt = system_prompt
        self.eleven_agent_id = eleven_agent_id
        self.created_at = datetime.utcnow().isoformat()
        self.updated_at = datetime.utcnow().isoformat()
    
    def to_dict(self) -> Dict:
        """Convert to dictionary"""
        return {
            "id": self.id,
            "name": self.name,
            "role": self.role,
            "maxInterviewMinutes": self.max_interview_minutes,
            "jobDescription": self.job_description,
            "interviewType": self.interview_type,
            "systemPrompt": self.system_prompt,
            "elevenAgentId": self.eleven_agent_id,
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
        }
    
    @staticmethod
    def from_dict(data: Dict) -> "AgentData":
        """Create from dictionary"""
        agent = AgentData(
            name=data["name"],
            role=data["role"],
            max_interview_minutes=data["maxInterviewMinutes"],
            job_description=data["jobDescription"],
            interview_type=data.get("interviewType", "technical"),
            system_prompt=data.get("systemPrompt"),
            eleven_agent_id=data.get("elevenAgentId"),
            agent_id=data.get("id"),
        )
        agent.created_at = data.get("createdAt", agent.created_at)
        agent.updated_at = data.get("updatedAt", agent.updated_at)
        return agent


class AgentsService:
    """Service for managing agents with ElevenLabs using Redis"""
    
    def __init__(self):
        self.api_key = settings.ELEVENLABS_API_KEY
        if not self.api_key:
            logger.warning("ELEVENLABS_API_KEY not configured")
        self.client = ElevenLabs(api_key=self.api_key) if self.api_key else None
        self.base_url = "https://api.elevenlabs.io/v1"
        self.redis = RedisStorage(key_prefix="agent")
    
    async def _read_agents(self) -> List[Dict]:
        """Read agents from Redis"""
        try:
            agents_data = await self.redis.get_all_json("*")
            # Convert dict to list format
            agents_list = list(agents_data.values())
            logger.debug("Loaded %d agents from Redis", len(agents_list))
            return agents_list
        except Exception as e:
            logger.error("Failed to read agents from Redis: %s", str(e))
            return []
    
    async def _save_agent(self, agent: AgentData):
        """Save a single agent to Redis"""
        try:
            success = await self.redis.set_json(agent.id, agent.to_dict())
            if success:
                logger.debug("Saved agent to Redis: %s", agent.id)
            else:
                logger.error("Failed to save agent to Redis: %s", agent.id)
        except Exception as e:
            logger.error("Failed to save agent to Redis: %s", str(e))
            raise
    
    async def _delete_agent_from_redis(self, agent_id: str) -> bool:
        """Delete an agent from Redis"""
        try:
            return await self.redis.delete(agent_id)
        except Exception as e:
            logger.error("Failed to delete agent from Redis: %s", str(e))
            return False
    
    def _get_interview_type_guidance(self, interview_type: str) -> str:
        """Get specific guidance based on interview type"""
        guidance_map = {
            "technical": """
**Interview Focus**: Technical skills and coding abilities
- Programming concepts and problem-solving
- Data structures and algorithms
- Code quality and best practices
- Technical depth in relevant technologies""",

            "system_design": """
**Interview Focus**: System architecture and scalability
- High-level system design
- Scalability and performance
- Database and API design
- Trade-offs and engineering decisions""",

            "behavioral": """
**Interview Focus**: Past experiences and soft skills
- Leadership and teamwork
- Conflict resolution
- Problem-solving approach
- Use STAR method (Situation, Task, Action, Result)""",

            "managerial": """
**Interview Focus**: Leadership and people management
- Team leadership and mentorship
- Strategic thinking and planning
- Performance management
- Decision-making and prioritization""",

            "hr": """
**Interview Focus**: Company culture fit and general assessment
- Career goals and motivations
- Work style and preferences
- Cultural alignment
- Compensation expectations""",

            "product": """
**Interview Focus**: Product thinking and user empathy
- Product sense and user understanding
- Feature prioritization
- Market analysis and strategy
- Metrics and success measurement""",

            "panel": """
**Interview Focus**: Comprehensive multi-faceted assessment
- Mix of technical, behavioral, and cultural assessment
- Cross-functional perspective
- Team compatibility""",

            "case_study": """
**Interview Focus**: Problem-solving with realistic scenarios
- Analytical thinking and structured approach
- Business acumen
- Creative problem-solving
- Data interpretation"""
        }
        
        return guidance_map.get(interview_type, guidance_map["technical"])
    
    def _build_agent_prompt(
        self, 
        role: str, 
        job_description: str, 
        max_minutes: int,
        interview_type: str = "technical",
        custom_prompt: Optional[str] = None
    ) -> str:
        """Build system prompt for the agent
        
        If custom_prompt is provided, it will be used as the base prompt with 
        time-tracking instructions appended. Otherwise, a default prompt with
        interview type-specific guidance is generated.
        """
        time_instructions = f"""

---
**Important Time Management**:
- This interview is scheduled for {max_minutes} minutes.
- Monitor the interview duration using {{{{system__call_duration_secs}}}}.
- When the interview reaches {max_minutes} minutes ({{{{system__call_duration_secs}}}} >= {max_minutes * 60} seconds), politely conclude and use the end_call tool.
- Also use the end_call tool if the candidate explicitly requests to end the interview early."""
        
        if custom_prompt:
            # Use custom prompt and append time-tracking instructions
            return custom_prompt + time_instructions
        
        # Build default prompt with interview type guidance
        interview_guidance = self._get_interview_type_guidance(interview_type)
        
        return f"""You are an AI interviewer conducting a structured, professional interview for the following position. Follow the rules below strictly to maximize signal quality and candidate experience.

**Position/Role**: {role}

**Interview Type**: {interview_type.replace('_', ' ').title()}

**Job Description for this Position**:
{job_description}

{interview_guidance}

**Operating Principles**:
1. Be professional, neutral, and encouraging; never be adversarial.
2. Optimize for signal: prefer depth over breadth; drill down on one topic at a time.
3. Actively listen and adapt questions to the candidate’s last answer.
4. Keep the interview aligned to the role and the interview type objectives.
5. Do not reveal internal scoring, hidden criteria, or the question list.
6. Never provide hints, sample scenarios, or answers unless explicitly requested for clarification.

**Turn-taking and Question Strategy**:
- Ask exactly one question per turn in ≤ 2 sentences and ≤ 30 words if possible.
- Avoid multi-part questions; use targeted follow-ups to probe depth ("why", "how", "trade-offs").
- Immediately yield and listen when the candidate starts speaking; never take consecutive turns.
- Briefly acknowledge key points using the candidate’s terms before the next follow-up (≤ 1 short clause).

**Evaluation (keep internal; do not disclose)**:
- Assess: correctness, clarity, reasoning, depth, real-world applicability, and communication.
- Prefer concrete examples, measurable outcomes, and trade-off awareness.
- Note red flags (hand-wavy answers, contradictions); do not surface these to the candidate.

**Scope and Safety**:
- Stay on-job and non-discriminatory; avoid personal, illegal, or sensitive topics.
- If asked for topics to be covered or for sample scenarios, decline and explain that the interview will proceed question-by-question.
- If the candidate asks for role-irrelevant content, steer back with a short rationale and a relevant question.

**Clarity and Style**:
- Keep turns brief (1–3 sentences). Prefer concrete, plain language. No jargon unless necessary.
- If asked to repeat or if silence/interruptions occur, restate only the last question in ≤ 1 sentence without re-introducing yourself or the role.
- Maintain a supportive, calm tone throughout.

{time_instructions}"""
    
    def _build_first_message(self, role: str, max_minutes: int) -> str:
        """Build first message for the agent"""
        return f"Hello! I'll be conducting your interview for the {role} position today. This will be a {max_minutes}-minute interview. Are you ready to begin?"
    
    async def create_agent(
        self,
        name: str,
        role: str,
        max_interview_minutes: int,
        job_description: str,
        interview_type: str = "technical",
        system_prompt: Optional[str] = None,
    ) -> AgentData:
        """Create a new agent in ElevenLabs and persist locally"""
        
        # Validate inputs
        if not name or len(name) > 100:
            raise ValueError("Agent name must be between 1 and 100 characters")
        
        if not role or len(role) > 200:
            raise ValueError("Interview role (position title) must be between 1 and 200 characters")
        
        if not 5 <= max_interview_minutes <= 180:
            raise ValueError("Max interview minutes must be between 5 and 180")
        
        if not job_description or len(job_description) > 5000:
            raise ValueError("Job description must be between 1 and 5000 characters")
        
        if system_prompt and len(system_prompt) > 10000:
            raise ValueError("System prompt must be less than 10000 characters")
        
        valid_types = ["technical", "system_design", "behavioral", "managerial", "hr", "product", "panel", "case_study"]
        if interview_type not in valid_types:
            raise ValueError(f"Interview type must be one of: {', '.join(valid_types)}")
        
        if not self.api_key:
            raise ValueError("ELEVENLABS_API_KEY not configured")
        
        logger.info("Creating agent: name=%s role=%s type=%s minutes=%d custom_prompt=%s", 
                   name, role, interview_type, max_interview_minutes, bool(system_prompt))
        
        try:
            # Build prompt and first message
            final_prompt = self._build_agent_prompt(role, job_description, max_interview_minutes, interview_type, system_prompt)
            first_message = self._build_first_message(role, max_interview_minutes)
            
            # Create agent via ElevenLabs API
            payload = {
                "name": name,
                "conversation_config": {
                    "agent": {
                        "prompt": {
                            "prompt": final_prompt,
                            "first_message": first_message,
                            "tools": [
                                {
                                    "type": "system",
                                    "name": "end_call",
                                    "description": f"End the call when the interview duration of {max_interview_minutes} minutes has elapsed or when the candidate requests to end the interview."
                                }
                            ]
                        }
                    }
                }
            }
            
            logger.debug("Creating ElevenLabs agent with payload: %s", json.dumps(payload, indent=2)[:500])
            
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.post(
                    f"{self.base_url}/convai/agents/create",
                    headers={
                        "xi-api-key": self.api_key,
                        "Content-Type": "application/json",
                    },
                    json=payload
                )
                
                if response.status_code == 429:
                    logger.warning("Rate limit hit when creating agent")
                    raise ValueError("Rate limit exceeded. Please try again later.")
                
                response.raise_for_status()
                result = response.json()
                
                eleven_agent_id = result.get("agent_id")
                if not eleven_agent_id:
                    logger.error("No agent_id in ElevenLabs response: %s", result)
                    raise ValueError("Failed to get agent ID from ElevenLabs")
                
                logger.info("ElevenLabs agent created: %s", eleven_agent_id)
            
            # Create local agent record
            agent = AgentData(
                name=name,
                role=role,
                max_interview_minutes=max_interview_minutes,
                job_description=job_description,
                interview_type=interview_type,
                system_prompt=system_prompt,
                eleven_agent_id=eleven_agent_id,
            )
            
            # Persist to Redis
            await self._save_agent(agent)
            
            logger.info("Agent persisted to Redis: id=%s", agent.id)
            return agent
            
        except httpx.HTTPStatusError as e:
            logger.error("ElevenLabs API error: %s - %s", e.response.status_code, e.response.text)
            raise ValueError(f"ElevenLabs API error: {e.response.status_code}")
        except Exception as e:
            logger.error("Failed to create agent: %s", str(e), exc_info=True)
            raise
    
    async def update_agent(
        self,
        agent_id: str,
        name: Optional[str] = None,
        role: Optional[str] = None,
        max_interview_minutes: Optional[int] = None,
        job_description: Optional[str] = None,
        interview_type: Optional[str] = None,
        system_prompt: Optional[str] = None,
    ) -> AgentData:
        """Update an existing agent"""
        
        # Load existing agent
        agents = await self._read_agents()
        agent_dict = next((a for a in agents if a["id"] == agent_id), None)
        
        if not agent_dict:
            raise ValueError(f"Agent {agent_id} not found")
        
        agent = AgentData.from_dict(agent_dict)
        
        # Update fields
        if name is not None:
            if not name or len(name) > 100:
                raise ValueError("Agent name must be between 1 and 100 characters")
            agent.name = name
        
        if role is not None:
            if not role or len(role) > 200:
                raise ValueError("Interview role (position title) must be between 1 and 200 characters")
            agent.role = role
        
        if max_interview_minutes is not None:
            if not 5 <= max_interview_minutes <= 180:
                raise ValueError("Max interview minutes must be between 5 and 180")
            agent.max_interview_minutes = max_interview_minutes
        
        if job_description is not None:
            if not job_description or len(job_description) > 5000:
                raise ValueError("Job description must be between 1 and 5000 characters")
            agent.job_description = job_description
        
        if system_prompt is not None:
            if system_prompt and len(system_prompt) > 10000:
                raise ValueError("System prompt must be less than 10000 characters")
            agent.system_prompt = system_prompt
        
        if interview_type is not None:
            valid_types = ["technical", "system_design", "behavioral", "managerial", "hr", "product", "panel", "case_study"]
            if interview_type not in valid_types:
                raise ValueError(f"Interview type must be one of: {', '.join(valid_types)}")
            agent.interview_type = interview_type
        
        if not self.api_key:
            raise ValueError("ELEVENLABS_API_KEY not configured")
        
        logger.info("Updating agent: id=%s", agent_id)
        
        try:
            # Build updated prompt
            final_prompt = self._build_agent_prompt(
                agent.role,
                agent.job_description,
                agent.max_interview_minutes,
                agent.interview_type,
                agent.system_prompt
            )
            first_message = self._build_first_message(agent.role, agent.max_interview_minutes)
            
            # Update via ElevenLabs API
            payload = {
                "name": agent.name,
                "conversation_config": {
                    "agent": {
                        "prompt": {
                            "prompt": final_prompt,
                            "first_message": first_message,
                            "tools": [
                                {
                                    "type": "system",
                                    "name": "end_call",
                                    "description": f"End the call when the interview duration of {agent.max_interview_minutes} minutes has elapsed or when the candidate requests to end the interview."
                                }
                            ]
                        }
                    }
                }
            }
            
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.patch(
                    f"{self.base_url}/convai/agents/{agent.eleven_agent_id}",
                    headers={
                        "xi-api-key": self.api_key,
                        "Content-Type": "application/json",
                    },
                    json=payload
                )
                
                if response.status_code == 429:
                    logger.warning("Rate limit hit when updating agent")
                    raise ValueError("Rate limit exceeded. Please try again later.")
                
                response.raise_for_status()
                logger.info("ElevenLabs agent updated: %s", agent.eleven_agent_id)
            
            # Update timestamp
            agent.updated_at = datetime.utcnow().isoformat()
            
            # Persist to Redis
            await self._save_agent(agent)
            
            logger.info("Agent updated in Redis: id=%s", agent_id)
            return agent
            
        except httpx.HTTPStatusError as e:
            logger.error("ElevenLabs API error: %s - %s", e.response.status_code, e.response.text)
            raise ValueError(f"ElevenLabs API error: {e.response.status_code}")
        except Exception as e:
            logger.error("Failed to update agent: %s", str(e), exc_info=True)
            raise
    
    async def get_agent(self, agent_id: str) -> Optional[AgentData]:
        """Get a single agent by ID"""
        agents = await self._read_agents()
        agent_dict = next((a for a in agents if a["id"] == agent_id), None)
        
        if not agent_dict:
            return None
        
        return AgentData.from_dict(agent_dict)
    
    async def list_agents(self) -> List[AgentData]:
        """List all agents"""
        agents = await self._read_agents()
        return [AgentData.from_dict(a) for a in agents]
    
    async def delete_agent(self, agent_id: str) -> bool:
        """Delete an agent from both Redis and ElevenLabs"""
        # Load agent to get ElevenLabs ID
        agents = await self._read_agents()
        agent_dict = next((a for a in agents if a["id"] == agent_id), None)
        
        if not agent_dict:
            logger.warning("Agent not found for deletion: id=%s", agent_id)
            return False
        
        eleven_agent_id = agent_dict.get("elevenAgentId")
        
        # Delete from ElevenLabs if we have the ID and API key
        if eleven_agent_id and self.api_key:
            try:
                async with httpx.AsyncClient(timeout=30.0) as client:
                    response = await client.delete(
                        f"{self.base_url}/convai/agents/{eleven_agent_id}",
                        headers={
                            "xi-api-key": self.api_key,
                        }
                    )
                    
                    if response.status_code == 404:
                        logger.warning("Agent not found in ElevenLabs (may have been deleted): %s", eleven_agent_id)
                    elif response.status_code == 429:
                        logger.warning("Rate limit hit when deleting agent")
                        raise ValueError("Rate limit exceeded. Please try again later.")
                    else:
                        response.raise_for_status()
                        logger.info("Agent deleted from ElevenLabs: %s", eleven_agent_id)
                        
            except httpx.HTTPStatusError as e:
                if e.response.status_code != 404:
                    logger.error("ElevenLabs API error during deletion: %s - %s", 
                               e.response.status_code, e.response.text)
                    raise ValueError(f"Failed to delete agent from ElevenLabs: {e.response.status_code}")
            except Exception as e:
                logger.error("Failed to delete agent from ElevenLabs: %s", str(e))
                raise
        
        # Delete from Redis
        await self._delete_agent_from_redis(agent_id)
        
        logger.info("Agent deleted from Redis and ElevenLabs: id=%s", agent_id)
        return True


# Global service instance
_agents_service: Optional[AgentsService] = None


def get_agents_service() -> AgentsService:
    """Get or create global agents service instance"""
    global _agents_service
    if _agents_service is None:
        _agents_service = AgentsService()
    return _agents_service

