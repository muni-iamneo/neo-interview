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
  private readonly AUTH_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6MywiZW1haWwiOiJtdW5peWFwcGFuLm1hbmlAaWFtbmVvLmFpIiwiZXhwaXJlX3RpbWUiOiIyMDI1LTEyLTAxVDEyOjE1OjM3Ljg3MDEzNCswMDowMCIsInBhc3N3b3JkX3ZlcnNpb24iOiJTd3QxclQifQ.eNiBFwz0WKOvOJTHMOOGZC-jmxGO9OrFOlovI3JS0yI';
  
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

