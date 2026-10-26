import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import { DomainError } from '../../domain/shared/domain-error';

@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse();
    if (error instanceof DomainError) {
      const status = error.code === 'INSUFFICIENT_FUNDS' || error.code === 'ROLLBACK_WOULD_OVERDRAW' ? HttpStatus.UNPROCESSABLE_ENTITY : HttpStatus.BAD_REQUEST;
      response.status(status).json({ statusCode: status, code: error.code, message: error.message });
      return;
    }
    if (error instanceof HttpException) {
      const status = error.getStatus(); response.status(status).json(error.getResponse()); return;
    }
    if (typeof error === 'object' && error !== null && 'code' in error) {
      const code = String((error as { code: unknown }).code);
      if (code === '23505') { response.status(HttpStatus.CONFLICT).json({ statusCode: 409, code: 'RESOURCE_CONFLICT' }); return; }
      if (code.startsWith('08') || code.startsWith('ECONN') || code === '57P01') { response.status(HttpStatus.SERVICE_UNAVAILABLE).json({ statusCode: 503, code: 'DEPENDENCY_UNAVAILABLE' }); return; }
    }
    const status = HttpStatus.INTERNAL_SERVER_ERROR;
    response.status(status).json({ statusCode: status, code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' });
  }
}
