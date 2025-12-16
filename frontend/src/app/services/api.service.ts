import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, of, throwError } from 'rxjs';
import { map, catchError } from 'rxjs/operators';
import { ConfigService } from './config.service';

export interface JWTRequest {
  room: string;
  user: {
    name: string;
    role?: 'participant' | 'moderator';
    email?: string;
    avatar?: string;
  };
  agentId?: string; // For ad-hoc sessions
  interviewId?: string; // New preferred field
  sessionId?: string; // Deprecated
  rejoin?: boolean;
  ttlSec?: number;
  features?: {
    transcription?: boolean;
    recording?: boolean;
    outbound_call?: boolean;
  };
  modTok?: string; // For moderator authentication
  job_description?: string;
  resume?: string;
  dynamic_variables?: { [key: string]: string };
}

export interface JWTResponse {
  domain: string;
  room: string;
  jwt: string;
  rejoin?: boolean;
}

export interface SessionInfo {
  sessionId: string;
  meetingId?: string;
  agentId: string;
  status: string;
  canRejoin: boolean;
  startTime?: number;
  endTime?: number;
  interviewStartTime?: number;
  maxInterviewMinutes?: number;
  endReason?: string;
  createdAt?: string;
  updatedAt?: string;
  roomName?: string;
}

export interface SessionsListResponse {
  items: SessionInfo[];
  total: number;
  page: number;
  size: number;
}

export interface CreateAgentRequest {
  name: string;
  role: string;
  interviewType: string;
  systemPrompt?: string;
  firstMessage?: string;
  language: string;
}

export interface AgentResponse {
  id: string;
  name: string;
  role: string;
  maxInterviewMinutes?: number;
  jobDescription?: string;
  interviewType: string;
  systemPrompt?: string;
  elevenAgentId?: string;
  voiceProvider?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface UpdateAgentRequest {
  name?: string;
  role?: string;
  interviewType?: string;
  systemPrompt?: string;
  firstMessage?: string;
  language?: string;
  voiceProvider?: string;
  elevenAgentId?: string;
}

export interface CreateLinkRequest {
  agentId: string;
  scheduledAt: string;       // REQUIRED: Interview scheduled start time (ISO 8601)
  roomName?: string;
  maxMinutes?: number;
  ttlMinutes?: number;
  job_description?: string;
  resume?: string;
}

export interface CreateLinkResponse {
  interviewId: string;
  roomName: string;
  expiresAt: string;
  scheduledAt?: string;
}

export interface LinkJoinInfo {
  interviewId: string;
  roomName: string;
  meetingUrl?: string;
  status: string;
  expiresAt: string;
  maxInterviewMinutes: number;
}

export interface LinkInfo {
  session_id: string;
  agent_id: string;
  status: string;
  created_at: string;
  expires_at: string;
  started_at?: string;
  ended_at?: string;
  meeting_url?: string;
  room_name?: string;
}

export interface ConversationDetails {
  id: string;
  agentId: string;
  status: string;
  startTime: string;
  endTime?: string;
  transcript?: any[];
}

export interface ConversationsListResponse {
  conversations: ConversationDetails[];
  nextCursor?: string;
}

export interface AnalysisResult {
  id: string;
  conversationId: string;
  summary: string;
  score?: number;
  feedback?: string;
}

@Injectable({
  providedIn: 'root'
})
export class ApiService {
  constructor(
    private http: HttpClient,
    private config: ConfigService
  ) {}  /**
   * Mint a JaaS JWT token
   * Maps to: POST /v1/sessions/join
   * Transforms request/response to match microservice API specification
   * 
   * Features:
   * - JWT reuse on rejoin (returns existing valid token)
   * - Auto-session creation for link-based interviews
   * - Smart TTL calculation from interview duration
   */
  mintJWT(request: JWTRequest): Observable<JWTResponse> {
    // Transform request to match microservice API format
    // Microservice API: POST /v1/sessions/join
    
    // Validate and clamp ttl_seconds to backend limits (60-86400)
    // Only include ttl_seconds if explicitly provided (optional field)
    let ttlSeconds: number | undefined = undefined;
    if (request.ttlSec !== undefined) {
      ttlSeconds = request.ttlSec || 3600;
      if (ttlSeconds < 60) ttlSeconds = 60;
      if (ttlSeconds > 86400) ttlSeconds = 86400;
    }
    
    // Build request body matching microservice spec
    const apiRequest: any = {
      room: request.room,
      user: request.user, // Pass user object directly
      ...(request.interviewId && { interviewId: request.interviewId }),
      ...(request.sessionId && { sessionId: request.sessionId }),
      ...(request.rejoin && { rejoin: request.rejoin }),
      ...(ttlSeconds !== undefined && { ttlSec: ttlSeconds }), // Note: backend expects ttlSec, not ttl_seconds for /join
      ...(request.modTok && { modTok: request.modTok }),
      ...(request.job_description && { job_description: request.job_description }),
      ...(request.resume && { resume: request.resume }),
      ...(request.agentId && { agent_id: request.agentId }),
      ...(request.dynamic_variables && { dynamic_variables: request.dynamic_variables })
    };

    // Make API call (response interceptor will unwrap {success, data, meta})
    return this.http.post<any>(
      this.config.getApiUrl('/v1/sessions/join'),
      apiRequest
    ).pipe(
      // Transform response to match frontend expectations
      map((response: any) => {
        console.log('🔍 mintJWT raw response:', response);

        // UNWRAP: Handle case where interceptor didn't unwrap
        let data = response;
        if (response && response.data) {
           console.log('⚠️ Response was not unwrapped by interceptor. Unwrapping manually.');
           data = response.data;
        }

        // Handle both old and new response formats
        let room = data.room;
        let domain = data.domain || '8x8.vc';
        const jwt = data.candidateJwt || data.token || data.jwt;
        
        // Strategy 1: Extract room and tenant from meetingUrl if available
        if (data.meetingUrl) {
          try {
            const url = new URL(data.meetingUrl);
            domain = url.hostname;
            // Path is usually /tenant/roomName
            const pathParts = url.pathname.split('/').filter(p => p);
            if (pathParts.length >= 2) {
              room = `${pathParts[0]}/${pathParts[1]}`;
            }
          } catch (e) {
            console.warn('Failed to parse meetingUrl:', e);
          }
        }

        // Strategy 2: Extract from JWT if room is still missing or incomplete
        if ((!room || !room.includes('/')) && jwt) {
          try {
            const parts = jwt.split('.');
            if (parts.length === 3) {
              const payload = JSON.parse(atob(parts[1]));
              if (payload.sub && payload.room) {
                // JaaS format: tenant/room
                room = `${payload.sub}/${payload.room}`;
                console.log('✅ Extracted room from JWT:', room);
              }
            }
          } catch (e) {
            console.warn('Failed to decode JWT for room extraction:', e);
          }
        }

        return {
          domain: domain,
          room: room,
          jwt: jwt,
          ...(data.rejoin && { rejoin: data.rejoin })
        };
      })
    );
  }

  // DEPRECATED: Session list/get endpoints have been removed from the API
  // Sessions are now auto-created when joining via interview links
  // Use interview link endpoints instead

  /**
   * Health check
   */
  healthCheck(): Observable<any> {
    return this.http.get(this.config.getApiUrl('/health'));
  }

  /**
   * Create a new agent
   * Maps to: POST /v1/agents
   */
  createAgent(request: CreateAgentRequest): Observable<AgentResponse> {
    const apiRequest: any = {
      name: request.name,
      role: request.role,
      interview_type: request.interviewType,
      system_prompt: request.systemPrompt,
      first_message: request.firstMessage,
      language: request.language
    };

    return this.http.post<any>(
      this.config.getApiUrl('/v1/agents'),
      apiRequest
    ).pipe(
      map((agent: any) => this.transformAgentResponse(agent))
    );
  }

  /**
   * Transform snake_case API response to camelCase AgentResponse
   */
  private transformAgentResponse(apiAgent: any): AgentResponse {
    // Handle both snake_case (from API) and camelCase (already transformed) responses
    return {
      id: apiAgent.id,
      name: apiAgent.name,
      role: apiAgent.role,
      maxInterviewMinutes: apiAgent.max_interview_minutes ?? apiAgent.maxInterviewMinutes,
      jobDescription: apiAgent.job_description ?? apiAgent.jobDescription,
      interviewType: apiAgent.interview_type ?? apiAgent.interviewType,
      systemPrompt: apiAgent.system_prompt ?? apiAgent.systemPrompt,
      elevenAgentId: apiAgent.elevenlabs_agent_id ?? apiAgent.elevenAgentId,
      voiceProvider: apiAgent.voice_provider ?? apiAgent.voiceProvider,
      createdAt: apiAgent.created_at ?? apiAgent.createdAt,
      updatedAt: apiAgent.updated_at ?? apiAgent.updatedAt
    };
  }

  /**
   * List all agents
   * Maps to: GET /v1/agents
   */
  listAgents(): Observable<AgentResponse[]> {
    return this.http.get<any>(
      this.config.getApiUrl('/v1/agents')
    ).pipe(
      map((response: any) => {
        // Handle different response structures
        // Case 1: Response is already an array (after interceptor unwrapping)
        if (Array.isArray(response)) {
          return response.map(agent => this.transformAgentResponse(agent));
        }
        
        // Case 2: Response has data field (if interceptor didn't unwrap)
        if (response && response.data && Array.isArray(response.data)) {
          return response.data.map((agent: any) => this.transformAgentResponse(agent));
        }
        
        // Case 3: Response is an object with data array
        if (response && typeof response === 'object' && 'data' in response) {
          const data = response.data;
          if (Array.isArray(data)) {
            return data.map((agent: any) => this.transformAgentResponse(agent));
          }
        }
        
        // Fallback: return empty array if structure is unexpected
        console.error('Unexpected response structure for listAgents:', {
          response,
          type: typeof response,
          isArray: Array.isArray(response),
          hasData: response?.data !== undefined,
          dataIsArray: Array.isArray(response?.data)
        });
        return [];
      })
    );
  }

  /**
   * Get a specific agent
   * Maps to: GET /v1/agents/{id}
   */
  getAgent(agentId: string): Observable<AgentResponse> {
    return this.http.get<any>(
      this.config.getApiUrl(`/v1/agents/${agentId}`)
    ).pipe(
      map((agent: any) => this.transformAgentResponse(agent))
    );
  }

  /**
   * Update an agent
   * Maps to: PUT /v1/agents/{id}
   */
  updateAgent(agentId: string, request: UpdateAgentRequest): Observable<AgentResponse> {
    return this.http.put<any>(
      this.config.getApiUrl(`/v1/agents/${agentId}`),
      request
    ).pipe(
      map((agent: any) => this.transformAgentResponse(agent))
    );
  }

  /**
   * Delete an agent
   * Maps to: DELETE /v1/agents/{id}
   */
  deleteAgent(agentId: string): Observable<void> {
    return this.http.delete<void>(
      this.config.getApiUrl(`/v1/agents/${agentId}`)
    );
  }



  // DEPRECATED: Session info endpoint removed from API
  // Sessions are auto-created on join and info is returned in join response



  /**
   * Create a new interview link
   * Maps to: POST /v1/links
   * Transforms camelCase to snake_case for microservice API
   * Note: Response interceptor unwraps {success, data, meta}, this handles field name transformation
   */
  createLink(request: CreateLinkRequest): Observable<CreateLinkResponse> {
    // Transform request from camelCase to snake_case for microservice
    const apiRequest: any = {
      agent_id: request.agentId,
      scheduledAt: request.scheduledAt  // REQUIRED field
    };
    
    // Add optional fields only if provided
    if (request.roomName) apiRequest.roomName = request.roomName;
    if (request.maxMinutes) apiRequest.max_interview_minutes = request.maxMinutes;
    if (request.ttlMinutes) apiRequest.ttl_minutes = request.ttlMinutes;
    if (request.job_description) apiRequest.job_description = request.job_description;
    if (request.resume) apiRequest.resume = request.resume;
    
    return this.http.post<any>(
      this.config.getApiUrl('/v1/links'),
      apiRequest
    ).pipe(
      // Response interceptor already unwraps {success, data, meta} → returns data
      map((response: any) => {
        // Handle case where response might still be wrapped (if interceptor didn't catch it)
        let responseData = response;
        if (response && typeof response === 'object' && 'success' in response && 'data' in response) {
          responseData = response.data;
        }
        
        return {
          interviewId: responseData.interviewId || responseData.interview_id,
          roomName: responseData.roomName || responseData.room_name,
          expiresAt: responseData.expiresAt || responseData.expires_at,
          scheduledAt: responseData.scheduledAt || responseData.scheduled_at
        };
      })
    );
  }

  /**
   * Update an existing interview link
   * Maps to: PUT /v1/links/{interview_id}
   */
  updateLink(interviewId: string, updates: Partial<CreateLinkRequest>): Observable<CreateLinkResponse> {
    const apiRequest: any = {};
    
    // Only include fields that are provided
    if (updates.scheduledAt !== undefined) apiRequest.scheduledAt = updates.scheduledAt;
    if (updates.maxMinutes !== undefined) apiRequest.max_interview_minutes = updates.maxMinutes;
    if (updates.ttlMinutes !== undefined) apiRequest.ttl_minutes = updates.ttlMinutes;
    
    return this.http.put<any>(
      this.config.getApiUrl(`/v1/links/${interviewId}`),
      apiRequest
    ).pipe(
      map((response: any) => {
        let responseData = response;
        if (response && typeof response === 'object' && 'success' in response && 'data' in response) {
          responseData = response.data;
        }
        
        return {
          interviewId: responseData.interviewId || responseData.interview_id,
          roomName: responseData.roomName || responseData.room_name,
          expiresAt: responseData.expiresAt || responseData.expires_at,
          scheduledAt: responseData.scheduledAt || responseData.scheduled_at
        };
      })
    );
  }


  /**
   * Get link join info (simplified info for landing page)
   * Maps to: GET /v1/links/{interview_id}/join
   */
  getLinkJoinInfo(interviewId: string): Observable<LinkJoinInfo> {
    return this.http.get<any>(
      this.config.getApiUrl(`/v1/links/${interviewId}/join`)
    ).pipe(
      map(data => ({
        interviewId: data.interviewId,
        roomName: data.roomName,
        meetingUrl: data.meetingUrl,
        status: data.status,
        expiresAt: data.expiresAt,
        maxInterviewMinutes: data.maxInterviewMinutes
      }))
    );
  }

  /**
   * Transform snake_case LinkInfo to camelCase
   */
  private transformLinkInfo(apiLink: any): LinkInfo {
    return {
      session_id: apiLink.session_id || apiLink.sessionId,
      agent_id: apiLink.agent_id || apiLink.agentId,
      status: apiLink.status,
      created_at: apiLink.created_at || apiLink.createdAt,
      expires_at: apiLink.expires_at || apiLink.expiresAt,
      started_at: apiLink.started_at || apiLink.startedAt,
      ended_at: apiLink.ended_at || apiLink.endedAt,
      meeting_url: apiLink.meeting_url || apiLink.meetingUrl,
      room_name: apiLink.room_name || apiLink.roomName
    };
  }

  /**
   * List links for an agent
   * Maps to: GET /v1/links/agent/{agent_id}
   */
  listAgentLinks(agentId: string, statusFilter?: string, limit: number = 10): Observable<LinkInfo[]> {
    let url = this.config.getApiUrl(`/v1/links/agent/${agentId}?limit=${limit}`);
    if (statusFilter) {
      url += `&status_filter=${statusFilter}`;
    }
    return this.http.get<any[]>(url).pipe(
      map((links: any[]) => links.map(link => this.transformLinkInfo(link)))
    );
  }

  /**
   * Get a specific link
   * Maps to: GET /v1/links/{session_id}
   */
  getLink(sessionId: string): Observable<LinkInfo> {
    return this.http.get<any>(
      this.config.getApiUrl(`/v1/links/${sessionId}`)
    ).pipe(
      map((link: any) => this.transformLinkInfo(link))
    );
  }

  /**
   * Delete/cancel a link
   * Maps to: DELETE /v1/links/{session_id}
   */
  deleteLink(sessionId: string): Observable<void> {
    return this.http.delete<void>(
      this.config.getApiUrl(`/v1/links/${sessionId}`)
    );
  }

}

