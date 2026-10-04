import 'reflect-metadata';
import { isTransientInfrastructureError } from './infrastructure-errors';
import {
  ArgumentsHost,
  Body,
  Catch,
  Controller,
  ExceptionFilter,
  Get,
  Headers,
  HttpException,
  HttpCode,
  Injectable,
  Module,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { Response } from 'express';
import { ConflictError, DomainError, NotFoundError } from '../domain/errors';
import { WageringService } from '../application/wagering';
import { Queues } from '../infrastructure/queues';
import { errorCode, log, registry } from '../infrastructure/telemetry';
/** Extension point: replace with OIDC JWT validation and provider claim enforcement. */
@Injectable()
export class ProviderAuthGuard implements CanActivate {
  canActivate(_context: ExecutionContext) {
    return true;
  }
}
@Catch()
class ApiExceptionFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    if (error instanceof DomainError) {
      const status =
        error instanceof ConflictError ? 409 : error instanceof NotFoundError ? 404 : 400;
      response.status(status).json({ code: error.code, message: error.message });
    } else if (error instanceof HttpException)
      response.status(error.getStatus()).json(error.getResponse());
    else {
      const transient = isTransientInfrastructureError(error);
      log(transient ? 'http_infrastructure_error' : 'http_internal_error', {
        code: errorCode(error),
        status: transient ? 503 : 500,
      });
      response.status(transient ? 503 : 500).json({
        code: transient ? 'TEMPORARY_UNAVAILABLE' : 'INTERNAL_ERROR',
        message: transient
          ? 'Falha temporária de infraestrutura. Reenvie usando a mesma Idempotency-Key.'
          : 'Erro interno inesperado.',
      });
    }
  }
}
export async function createApi(service: WageringService, queues: Queues) {
  @Controller()
  @UseGuards(ProviderAuthGuard)
  class FinancialController {
    @Post('wallets') create(
      @Body() body: unknown,
      @Headers('x-correlation-id') correlation?: string,
    ) {
      return service.createWallet(body, { correlationId: correlation ?? crypto.randomUUID() });
    }
    @Get('wallets/:id') wallet(@Param('id') id: string) {
      return service.getWallet(id);
    }
    @Get('wallets/:id/ledger') ledger(
      @Param('id') id: string,
      @Query('cursor') cursor?: string,
      @Query('limit') limit?: string,
    ) {
      return service.ledger(id, cursor, limit);
    }
    @Post('wallets/:id/reconciliation') @HttpCode(200) reconciliation(
      @Param('id') id: string,
      @Headers('x-correlation-id') correlation?: string,
    ) {
      return service.reconcile(id, { correlationId: correlation ?? crypto.randomUUID() });
    }
    @Get('wagering/transactions/:id') transaction(@Param('id') id: string) {
      return service.getTransaction(id);
    }
    @Get('providers/:provider/wagering/transactions/:external') providerTransaction(
      @Param('provider') provider: string,
      @Param('external') external: string,
    ) {
      return service.getProviderTransaction(provider, external);
    }
    @Post('wagering/transactions') async submit(
      @Body() body: unknown,
      @Headers('idempotency-key') key: string,
      @Headers('x-correlation-id') correlation: string | undefined,
      @Res() response: Response,
    ) {
      const result = await service.submit(body, key, {
        correlationId: correlation ?? crypto.randomUUID(),
      });
      response
        .status(
          result.status === 'REJECTED'
            ? 422
            : result.status === 'PENDING_REFERENCE' || result.status === 'PENDING'
              ? 202
              : result.status === 'FAILED'
                ? 500
                : 200,
        )
        .json(result);
    }
  }
  @Controller()
  class HealthController {
    @Get('health/live') live() {
      return { status: 'ok' };
    }
    @Get('health/ready') async ready(@Res() response: Response) {
      try {
        await Promise.all([service.orm.em.fork().execute('SELECT 1'), queues.ready()]);
        response.status(200).json({ status: 'ready' });
      } catch {
        response.status(503).json({ status: 'not_ready' });
      }
    }
    @Get('metrics') async metrics(@Res() response: Response) {
      response.type(registry.contentType).send(await registry.metrics());
    }
  }
  @Module({ controllers: [FinancialController, HealthController], providers: [ProviderAuthGuard] })
  class AppModule {}
  const app = await NestFactory.create(AppModule, { logger: false });
  app.useGlobalFilters(new ApiExceptionFilter());
  return app;
}
