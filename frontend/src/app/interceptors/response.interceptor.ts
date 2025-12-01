import { HttpInterceptorFn, HttpErrorResponse, HttpResponse } from '@angular/common/http';
import { catchError, map, throwError } from 'rxjs';

/**
 * Standard API Response Format
 */
interface ApiResponse<T> {
  success: boolean;
  data: T;
  meta?: {
    request_id?: string;
    team_id?: string;
  };
}

/**
 * Response Interceptor
 * Unwraps the standardized {success, data, meta} response format
 * Handles error responses and extracts error messages
 */
export const responseInterceptor: HttpInterceptorFn = (req, next) => {
  return next(req).pipe(
    map((event) => {
      // Check if this is an HttpResponse
      if (event instanceof HttpResponse) {
        const body = event.body;

        // Skip unwrapping for non-JSON responses or if response is already unwrapped
        if (!body || typeof body !== 'object') {
          return event;
        }

        // Check if response has the standard API format
        if ('success' in body && 'data' in body) {
          const apiResponse = body as ApiResponse<any>;
          
          // If response has the standard format, unwrap it
          if (apiResponse.success !== undefined && apiResponse.data !== undefined) {
            // Return a cloned HttpResponse with the unwrapped data as the body
            return event.clone({ body: apiResponse.data });
          }
        }
      }

      return event;
    }),
    catchError((error: HttpErrorResponse) => {
      // Handle error responses with standard format
      if (error.error && typeof error.error === 'object') {
        const errorResponse = error.error as ApiResponse<any>;
        
        // If error has standard format, extract message
        if (errorResponse.success === false && errorResponse.data) {
          // Create a new error with the unwrapped data
          const unwrappedError = new HttpErrorResponse({
            error: errorResponse.data,
            status: error.status,
            statusText: error.statusText,
            url: error.url || undefined
          });
          return throwError(() => unwrappedError);
        }
      }

      return throwError(() => error);
    })
  );
};

