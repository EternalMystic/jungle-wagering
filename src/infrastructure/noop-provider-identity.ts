import type { ProviderIdentityPort } from "../application/ports/provider-identity";

/** D11: autenticação externa é um ponto de extensão, desabilitado neste desafio. */
export class NoopProviderIdentity implements ProviderIdentityPort {
  async authenticate(): Promise<undefined> { return undefined; }
}
