import { type CanActivate, type ExecutionContext, ForbiddenException, Inject, Injectable } from "@nestjs/common";
import type { Request } from "express";
import type { ProviderIdentityPort } from "../../application/ports/provider-identity";
import { enrichLogContext } from "../../infrastructure/logging/log-context";

export const PROVIDER_IDENTITY = Symbol("PROVIDER_IDENTITY");

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(PROVIDER_IDENTITY) private readonly identity: ProviderIdentityPort) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const identity = await this.identity.authenticate(request.get("authorization"));
    const providerId: unknown = request.params.providerId ?? (request.body as { providerId?: unknown } | undefined)?.providerId;
    const walletId: unknown = request.params.walletId ?? (request.body as { walletId?: unknown } | undefined)?.walletId;
    enrichLogContext({
      ...(typeof providerId === "string" && providerId.length <= 128 ? { providerId } : {}),
      ...(typeof walletId === "string" && walletId.length <= 128 ? { walletId } : {}),
      ...(typeof request.params.transactionId === "string" ? { transactionId: request.params.transactionId } : {}),
    });
    if (identity !== undefined && providerId !== undefined && identity.providerId !== providerId) throw new ForbiddenException();
    return true;
  }
}
