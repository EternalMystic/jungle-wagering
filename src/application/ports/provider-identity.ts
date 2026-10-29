export interface ProviderIdentity {
  readonly providerId: string;
}

export interface ProviderIdentityPort {
  authenticate(authorization: string | undefined): Promise<ProviderIdentity | undefined>;
}
