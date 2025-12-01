import { HttpInterceptorFn, HttpRequest } from '@angular/common/http';
import { inject } from '@angular/core';
import { AuthService } from '../services/auth.service';

/**
 * Authentication Interceptor
 * Injects Authorization and X-Team-ID headers into all HTTP requests
 * Skips authentication for /health endpoint
 */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const authService = inject(AuthService);

  // Skip authentication for health check endpoint
  if (req.url.includes('/health')) {
    return next(req);
  }

  // Skip if already has Authorization header
  if (req.headers.has('Authorization')) {
    return next(req);
  }

  // Add authentication headers
  const token = authService.getToken();
  const teamId = authService.getTeamId();

  if (token && teamId) {
    const clonedReq = req.clone({
      setHeaders: {
        'Authorization': `Bearer ${token}`,
        'X-Team-ID': teamId
      }
    });
    return next(clonedReq);
  }

  return next(req);
};

