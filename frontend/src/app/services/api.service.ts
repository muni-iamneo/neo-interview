import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { ConfigService } from './config.service';

export interface JWTRequest {
  room: string;
  user: { name: string; [key: string]: any };
  features?: { [key: string]: boolean };
  ttlSec?: number;
}

export interface JWTResponse {
  domain: string;
  room: string;
  jwt: string;
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
}

export interface UpdateAgentRequest {
  name?: string;
  role?: string;
  maxInterviewMinutes?: number;
  jobDescription?: string;
  interviewType?: string;
  systemPrompt?: string;
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
   */
  mintJWT(request: JWTRequest): Observable<JWTResponse> {
    return this.http.post<JWTResponse>(
      this.config.getApiUrl('/jaas/jwt'),
      request
    );
  }

  /**
   * Get all active voice sessions
   */
  getVoiceSessions(): Observable<SessionsOverview> {
    return this.http.get<SessionsOverview>(
      this.config.getApiUrl('/voice/sessions')
    );
  }

  /**
   * Get specific voice session status
   */
  getVoiceSessionStatus(sessionId: string): Observable<SessionStatus> {
    return this.http.get<SessionStatus>(
      this.config.getApiUrl(`/voice/sessions/${sessionId}`)
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
   */
  createAgent(request: CreateAgentRequest): Observable<AgentResponse> {
    return this.http.post<AgentResponse>(
      this.config.getApiUrl('/api/agents'),
      request
    );
  }

  /**
   * List all agents
   */
  listAgents(): Observable<AgentResponse[]> {
    return this.http.get<AgentResponse[]>(
      this.config.getApiUrl('/api/agents')
    );
  }

  /**
   * Get a specific agent
   */
  getAgent(agentId: string): Observable<AgentResponse> {
    return this.http.get<AgentResponse>(
      this.config.getApiUrl(`/api/agents/${agentId}`)
    );
  }

  /**
   * Update an agent
   */
  updateAgent(agentId: string, request: UpdateAgentRequest): Observable<AgentResponse> {
    return this.http.put<AgentResponse>(
      this.config.getApiUrl(`/api/agents/${agentId}`),
      request
    );
  }

  /**
   * Delete an agent
   */
  deleteAgent(agentId: string): Observable<void> {
    return this.http.delete<void>(
      this.config.getApiUrl(`/api/agents/${agentId}`)
    );
  }

  /**
   * Configure a voice session with agent and dynamic variables
   */
  configureSession(sessionId: string, request: ConfigureSessionRequest): Observable<ConfigureSessionResponse> {
    return this.http.post<ConfigureSessionResponse>(
      this.config.getApiUrl(`/voice/sessions/${sessionId}/configure`),
      request
    );
  }

  /**
   * Resume a dropped/paused session
   */
  resumeSession(sessionId: string): Observable<any> {
    return this.http.post<any>(
      this.config.getApiUrl(`/voice/sessions/${sessionId}/resume`),
      {}
    );
  }

  /**
   * Get session information
   */
  getSessionInfo(sessionId: string): Observable<SessionInfo> {
    return this.http.get<SessionInfo>(
      this.config.getApiUrl(`/voice/sessions/${sessionId}/info`)
    );
  }

  /**
   * Get session history for an agent
   */
  getAgentSessionHistory(agentId: string): Observable<{ agentId: string; sessions: SessionInfo[]; totalCount: number }> {
    return this.http.get<{ agentId: string; sessions: SessionInfo[]; totalCount: number }>(
      this.config.getApiUrl(`/voice/sessions/agent/${agentId}/history`)
    );
  }

  /**
   * Create a new interview link
   */
  createLink(request: CreateLinkRequest): Observable<CreateLinkResponse> {
    return this.http.post<CreateLinkResponse>(
      this.config.getApiUrl('/api/links'),
      request
    );
  }

  /**
   * List links for an agent
   */
  listAgentLinks(agentId: string, statusFilter?: string, limit: number = 10): Observable<LinkInfo[]> {
    let url = this.config.getApiUrl(`/api/links/agent/${agentId}?limit=${limit}`);
    if (statusFilter) {
      url += `&status_filter=${statusFilter}`;
    }
    return this.http.get<LinkInfo[]>(url);
  }

  /**
   * Get a specific link
   */
  getLink(sessionId: string): Observable<LinkInfo> {
    return this.http.get<LinkInfo>(
      this.config.getApiUrl(`/api/links/${sessionId}`)
    );
  }

  /**
   * Delete/cancel a link
   */
  deleteLink(sessionId: string): Observable<void> {
    return this.http.delete<void>(
      this.config.getApiUrl(`/api/links/${sessionId}`)
    );
  }

  /**
   * List conversations for an agent (with pagination)
   */
  listAgentConversations(agentId: string, cursor?: string, pageSize: number = 30): Observable<ConversationsListResponse> {
    let url = this.config.getApiUrl(`/api/conversations/agent/${agentId}?page_size=${pageSize}`);
    if (cursor) {
      url += `&cursor=${cursor}`;
    }
    return this.http.get<ConversationsListResponse>(url);
  }

  /**
   * Get conversation details with transcript
   */
  getConversationDetails(conversationId: string): Observable<ConversationDetails> {
    return this.http.get<ConversationDetails>(
      this.config.getApiUrl(`/api/conversations/${conversationId}`)
    );
  }

  /**
   * Generate AI analysis for a conversation
   */
  generateAnalysis(conversationId: string, forceRegenerate: boolean = false): Observable<AnalysisResult> {
    return this.http.post<AnalysisResult>(
      this.config.getApiUrl(`/api/conversations/${conversationId}/analyze`),
      { force_regenerate: forceRegenerate }
    );
  }

  /**
   * Get stored analysis for a conversation
   */
  getAnalysis(conversationId: string): Observable<AnalysisResult> {
    return this.http.get<AnalysisResult>(
      this.config.getApiUrl(`/api/conversations/${conversationId}/analysis`)
    );
  }

  /**
   * Delete stored analysis
   */
  deleteAnalysis(conversationId: string): Observable<void> {
    return this.http.delete<void>(
      this.config.getApiUrl(`/api/conversations/${conversationId}/analysis`)
    );
  }
}

