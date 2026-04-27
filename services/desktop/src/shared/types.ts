// Types shared across the main / preload / renderer boundaries.
//
// Each tsconfig project (node vs web) is sealed off from the other, so
// any type that crosses the boundary lives here and gets imported via
// type-only imports on both sides.

export interface AppConfig {
  gatewayUrl: string;
}

export interface AuthStatus {
  signedIn: boolean;
  accessToken: string | null;
  expiresAt: number | null;
  // Decoded for UI display only; gateway re-verifies the JWT signature.
  actorId: string | null;
  tenantId: string | null;
  scopes: string[];
}
