import { HttpInterceptorFn, HttpErrorResponse } from '@angular/common/http';
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
    map((response: any) => {
      // Skip unwrapping for non-JSON responses or if response is already unwrapped
      if (!response || typeof response !== 'object') {
        return response;
      }

      // Check if response has the standard API format
      if ('success' in response && 'data' in response) {
        const apiResponse = response as ApiResponse<any>;
        
        // If response has the standard format, unwrap it
        if (apiResponse.success !== undefined && apiResponse.data !== undefined) {
          // Return the data directly
          return apiResponse.data;
        }
      }

      return response;
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

