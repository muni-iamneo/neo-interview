import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, of, throwError } from 'rxjs';
import { map, catchError } from 'rxjs/operators';
import { ConfigService } from './config.service';

export interface JWTRequest {
  room: string;
  user: { name: string; [key: string]: any };
  features?: { [key: string]: boolean };
  ttlSec?: number;
  // Legacy fields for backward compatibility
  sessionId?: string;
  rejoin?: boolean;
  modTok?: string;
}

// New API response format (unwrapped by response interceptor)
export interface JWTResponseData {
  token: string;
  room: string;
  domain: string;
  expires_at?: number;
  ttl_seconds?: number;
  rejoin?: boolean; // Indicates if token was reused from existing session
}

// Frontend-compatible response format
export interface JWTResponse {
  domain: string;
  room: string;
  jwt: string;
  rejoin?: boolean; // Optional flag indicating token reuse
}

export interface SessionStatus {
  active: boolean;
  ready?: boolean;
  started?: boolean;
}

export interface SessionsOverview {
  active_sessions: number;
  timestamp: number;
}

export interface CreateAgentRequest {
  name: string;
  role: string;
  maxInterviewMinutes: number;
  jobDescription: string;
  interviewType?: string;
  systemPrompt?: string;
  voiceProvider?: string;
}

export interface UpdateAgentRequest {
  name?: string;
  role?: string;
  maxInterviewMinutes?: number;
  jobDescription?: string;
  interviewType?: string;
  systemPrompt?: string;
  voiceProvider?: string;
}

export interface AgentResponse {
  id: string;
  name: string;
  role: string;
  maxInterviewMinutes: number;
  jobDescription: string;
  interviewType: string;
  systemPrompt?: string;
  elevenAgentId?: string;
  voiceProvider?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConfigureSessionRequest {
  agentId?: string;
  elevenAgentId?: string;
  dynamicVariables?: { [key: string]: string };
}

export interface ConfigureSessionResponse {
  success: boolean;
  sessionId: string;
  elevenAgentId: string;
  message: string;
}

export interface SessionInfo {
  sessionId: string;
  meetingId: string;
  agentId: string;
  status: string;
  canRejoin: boolean;
  startTime?: number;
  endTime?: number;
  lastActivity?: number;
  interviewStartTime?: number;
  maxInterviewMinutes?: number;
  endReason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateLinkRequest {
  agentId: string;
  maxMinutes?: number;
  ttlMinutes?: number;
}

export interface CreateLinkResponse {
  sessionId: string;
  candidateUrl: string;
  moderatorUrl: string;
  meetingUrl: string;
  roomName: string;
  expiresAt: string;
  candidateJwt?: string; // Pre-generated JWT for candidate (optional for backward compatibility)
}

export interface LinkInfo {
  session_id: string;
  agent_id: string;
  status: string;
  created_at: string;
  expires_at?: string;
  started_at?: number;
  ended_at?: number;
  meeting_url?: string;
  room_name?: string;
}

export interface ConversationInfo {
  conversation_id: string;
  agent_id: string;
  start_time: string;
  call_duration_secs: number;
  status: string;
}

export interface TranscriptSegment {
  role: string;
  message: string;
  timestamp?: number;
}

export interface ConversationDetails {
  conversation_id: string;
  agent_id: string;
  transcript: TranscriptSegment[];
  formatted_transcript: string;
  metadata: { [key: string]: any };
}

export interface AnalysisResult {
  conversation_id: string;
  agent_id?: string;
  analysis: {
    hiring_recommendation: 'hire' | 'no-hire' | 'consider';
    subject_knowledge: { [subject: string]: string };
    reasoning: string;
    strengths: string[];
    concerns: string[];
  };
  generated_at: string;
}

export interface ConversationsListResponse {
  conversations: ConversationInfo[];
  next_cursor: string | null;
}

export interface AnalyzeRequest {
  force_regenerate?: boolean;
}

@Injectable({
  providedIn: 'root'
})
export class ApiService {
  constructor(
    private http: HttpClient,
    private config: ConfigService
  ) {}

  /**
   * Mint a JaaS JWT token
   * Maps to: POST /v1/jaas/jwt
   * Transforms request/response to match microservice API specification
   * 
   * Features:
   * - JWT reuse on rejoin (returns existing valid token)
   * - Auto-session creation for link-based interviews
   * - Smart TTL calculation from interview duration
   */
  mintJWT(request: JWTRequest): Observable<JWTResponse> {
    // Transform request to match microservice API format
    // Microservice API: POST /v1/jaas/jwt
    // Validation: room (1-200 chars), user_name (1-100 chars), ttl_seconds (60-86400)
    
    const userRole = request.user['role'] || 'participant';
    const userEmail = request.user['email'] || null; // Send null instead of empty string for optional field
    
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
      user: {
        name: request.user.name,
        ...(userRole && { role: userRole }),
        ...(userEmail && { email: userEmail })
      },
      ...(request.sessionId && { sessionId: request.sessionId }),
      ...(request.rejoin && { rejoin: request.rejoin }),
      ...(ttlSeconds !== undefined && { ttl_seconds: ttlSeconds }),
      ...(request.features && { features: request.features }),
      ...(request.modTok && { modTok: request.modTok })
    };

    // Make API call (response interceptor will unwrap {success, data, meta})
    return this.http.post<JWTResponseData>(
      this.config.getApiUrl('/v1/jaas/jwt'),
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

  /**
   * Get all active voice sessions
   * Maps to: GET /v1/sessions
   */
  getVoiceSessions(): Observable<SessionsOverview> {
    return this.http.get<SessionsOverview>(
      this.config.getApiUrl('/v1/sessions')
    );
  }

  /**
   * Get specific voice session status
   * Maps to: GET /v1/sessions/{id}
   */
  getVoiceSessionStatus(sessionId: string): Observable<SessionStatus> {
    return this.http.get<SessionStatus>(
      this.config.getApiUrl(`/v1/sessions/${sessionId}`)
    );
  }

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
    return this.http.post<any>(
      this.config.getApiUrl('/v1/agents'),
      request
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

  /**
   * Configure a voice session with agent and dynamic variables
   * Maps to: POST /v1/sessions/{id}/configure
   * Transforms camelCase to snake_case for microservice API
   */
  configureSession(sessionId: string, request: ConfigureSessionRequest): Observable<ConfigureSessionResponse> {
    // Transform request from camelCase to snake_case for microservice
    const apiRequest: any = {
      agent_id: request.agentId,
      eleven_agent_id: request.elevenAgentId,
      dynamic_variables: request.dynamicVariables || {}
    };
    
    return this.http.post<ConfigureSessionResponse>(
      this.config.getApiUrl(`/v1/sessions/${sessionId}/configure`),
      apiRequest
    );
  }

  /**
   * Resume a dropped/paused session
   * Maps to: POST /v1/sessions/{id}/resume
   */
  resumeSession(sessionId: string): Observable<any> {
    return this.http.post<any>(
      this.config.getApiUrl(`/v1/sessions/${sessionId}/resume`),
      {}
    );
  }

  /**
   * Get session information
   * Maps to: GET /v1/sessions/{id} (same endpoint as getVoiceSessionStatus)
   */
  getSessionInfo(sessionId: string): Observable<SessionInfo> {
    return this.http.get<SessionInfo>(
      this.config.getApiUrl(`/v1/sessions/${sessionId}`)
    );
  }

  /**
   * Get session history for an agent
   * NOTE: This endpoint is not available in microservice. 
   * Use getVoiceSessions() and filter by agent_id on the client side.
   * @deprecated Use getVoiceSessions() and filter client-side
   */
  getAgentSessionHistory(agentId: string): Observable<{ agentId: string; sessions: SessionInfo[]; totalCount: number }> {
    // Fallback: return empty result since endpoint doesn't exist
    return this.http.get<{ agentId: string; sessions: SessionInfo[]; totalCount: number }>(
      this.config.getApiUrl(`/v1/sessions?agent_id=${agentId}`)
    );
  }

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
      max_minutes: request.maxMinutes,
      ttl_minutes: request.ttlMinutes
    };
    
    return this.http.post<any>(
      this.config.getApiUrl('/v1/links'),
      apiRequest
    ).pipe(
      // Response interceptor already unwraps {success, data, meta} → returns data
      // Transform from snake_case to camelCase (handles both formats defensively)
      map((response: any) => {
        // Handle case where response might still be wrapped (if interceptor didn't catch it)
        let responseData = response;
        if (response && typeof response === 'object' && 'success' in response && 'data' in response) {
          responseData = response.data;
        }
        
        return {
          sessionId: responseData.session_id || responseData.sessionId,
          candidateUrl: responseData.candidate_url || responseData.candidateUrl,
          moderatorUrl: responseData.moderator_url || responseData.moderatorUrl,
          meetingUrl: responseData.meeting_url || responseData.meetingUrl,
          roomName: responseData.room_name || responseData.roomName,
          expiresAt: responseData.expires_at || responseData.expiresAt,
          candidateJwt: responseData.candidate_jwt || responseData.candidateJwt // Pre-generated JWT for candidate
        };
      }),
      catchError((error: any) => {
        // If backend sends validation error but includes data in error response, try to extract it
        if (error.error && typeof error.error === 'object') {
          const errorBody = error.error;
          
          // Check if error has wrapped data structure
          if (errorBody.success && errorBody.data && typeof errorBody.data === 'object') {
            const responseData = errorBody.data;
            // Extract and transform the data (backend validation failed but data exists)
            return of({
              sessionId: responseData.session_id || responseData.sessionId,
              candidateUrl: responseData.candidate_url || responseData.candidateUrl,
              moderatorUrl: responseData.moderator_url || responseData.moderatorUrl,
              meetingUrl: responseData.meeting_url || responseData.meetingUrl,
              roomName: responseData.room_name || responseData.roomName,
              expiresAt: responseData.expires_at || responseData.expiresAt
            });
          }
        }
        
        // Re-throw original error
        return throwError(() => error);
      })
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

  /**
   * List conversations for an agent (with pagination)
   * NOTE: This endpoint is not available in microservice (non-critical studio feature)
   * @deprecated Endpoint not available in microservice
   */
  listAgentConversations(agentId: string, cursor?: string, pageSize: number = 30): Observable<ConversationsListResponse> {
    throw new Error('Conversations endpoint not available in microservice. This is a non-critical studio feature.');
  }

  /**
   * Get conversation details with transcript
   * NOTE: This endpoint is not available in microservice (non-critical studio feature)
   * @deprecated Endpoint not available in microservice
   */
  getConversationDetails(conversationId: string): Observable<ConversationDetails> {
    throw new Error('Conversations endpoint not available in microservice. This is a non-critical studio feature.');
  }

  /**
   * Generate AI analysis for a conversation
   * NOTE: This endpoint is not available in microservice (non-critical studio feature)
   * @deprecated Endpoint not available in microservice
   */
  generateAnalysis(conversationId: string, forceRegenerate: boolean = false): Observable<AnalysisResult> {
    throw new Error('Conversations endpoint not available in microservice. This is a non-critical studio feature.');
  }

  /**
   * Get stored analysis for a conversation
   * NOTE: This endpoint is not available in microservice (non-critical studio feature)
   * @deprecated Endpoint not available in microservice
   */
  getAnalysis(conversationId: string): Observable<AnalysisResult> {
    throw new Error('Conversations endpoint not available in microservice. This is a non-critical studio feature.');
  }

  /**
   * Delete stored analysis
   * NOTE: This endpoint is not available in microservice (non-critical studio feature)
   * @deprecated Endpoint not available in microservice
   */
  deleteAnalysis(conversationId: string): Observable<void> {
    throw new Error('Conversations endpoint not available in microservice. This is a non-critical studio feature.');
  }
}

