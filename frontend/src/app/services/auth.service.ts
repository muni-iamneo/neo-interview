import { Injectable } from '@angular/core';

/**
 * Authentication Service
 * Manages JWT token and team ID for API authentication
 */
@Injectable({
  providedIn: 'root'
})
export class AuthService {
  // Hardcoded JWT token for development (team_id: "hire")
  // this token is generated from the backend with expiry time of 1 hour
  private readonly AUTH_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6MSwiZW1haWwiOiJydXNob0BpYW1uZW8uYWkiLCJleHBpcmVfdGltZSI6IjIwMjUtMTItMDRUMTQ6MzY6MTguOTg3MzkwKzAwOjAwIiwicGFzc3dvcmRfdmVyc2lvbiI6ImN5UWxCTCJ9.htwUgbv0FvYWEQ-t051uzab64Er5DIW4d2NPcJEwBZw';
  
  // Team ID for X-Team-ID header
  private readonly TEAM_ID = 'hire';

  constructor() {}

  /**
   * Get the JWT token
   */
  getToken(): string {
    return this.AUTH_TOKEN;
  }

  /**
   * Get the team ID
   */
  getTeamId(): string {
    return this.TEAM_ID;
  }

  /**
   * Check if user is authenticated
   */
  isAuthenticated(): boolean {
    return !!this.AUTH_TOKEN;
  }
}

