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
}

