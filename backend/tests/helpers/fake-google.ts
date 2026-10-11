import type {
  AuthorizationParams,
  GoogleIdentity,
  GoogleOAuthProvider,
} from "@/modules/auth/google.provider";

/**
 * Test double for Google. It records the state/nonce embedded in the
 * authorization URL (exactly what a real provider would sign into the ID token)
 * and returns pre-registered identities for authorization codes.
 */
export class FakeGoogleProvider implements GoogleOAuthProvider {
  readonly isConfigured = true;
  readonly missingConfig: string[] = [];
  lastParams: AuthorizationParams | undefined;
  private readonly identities = new Map<string, Partial<GoogleIdentity> & Pick<GoogleIdentity, "sub" | "email">>();
  /** When set, the ID token carries this nonce instead of the one that was requested. */
  nonceOverride: string | undefined;
  failExchange = false;

  buildAuthorizationUrl(params: AuthorizationParams): string {
    this.lastParams = params;
    const url = new URL("https://accounts.google.test/o/oauth2/v2/auth");
    url.searchParams.set("state", params.state);
    url.searchParams.set("nonce", params.nonce);
    url.searchParams.set("code_challenge", params.codeChallenge);
    return url.toString();
  }

  register(code: string, identity: Partial<GoogleIdentity> & Pick<GoogleIdentity, "sub" | "email">): void {
    this.identities.set(code, identity);
  }

  exchangeCode(input: { code: string; codeVerifier: string }): Promise<GoogleIdentity> {
    if (this.failExchange) return Promise.reject(new Error("exchange failed"));
    const identity = this.identities.get(input.code);
    if (!identity) return Promise.reject(new Error("invalid_grant"));
    return Promise.resolve({
      emailVerified: true,
      name: identity.email.split("@")[0] ?? "user",
      nonce: this.nonceOverride ?? this.lastParams?.nonce,
      ...identity,
    });
  }
}
