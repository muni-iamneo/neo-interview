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
}

