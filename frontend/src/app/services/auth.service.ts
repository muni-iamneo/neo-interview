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
  private readonly AUTH_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6NSwiZW1haWwiOiJtdW5peWFwcGFuLm1hbmlAaWFtbmVvLmFpIiwiZXhwaXJlX3RpbWUiOiIyMDI1LTEyLTA3VDE1OjU5OjA5LjE2MDUwMiswMDowMCIsInBhc3N3b3JkX3ZlcnNpb24iOiJQbDdraGEifQ.Yg7C2-btonsJSOZ8xgJZl1PBbNB9Nw4G72O_Oms3Ck8';
  
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

