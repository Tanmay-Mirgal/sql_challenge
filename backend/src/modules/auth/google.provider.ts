import { OAuth2Client } from "google-auth-library";
import type { AppConfig } from "@/config";

export interface GoogleIdentity {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string;
  picture?: string;
  hostedDomain?: string;
  /** Nonce echoed by Google inside the signed ID token. */
  nonce?: string;
}

export interface AuthorizationParams {
  state: string;
  nonce: string;
  codeChallenge: string;
  hostedDomainHint?: string;
}

/**
 * Narrow interface over Google's OAuth endpoints so the login flow (state,
 * nonce, PKCE, domain policy, account linking) can be exercised in tests
 * without calling Google.
 */
export interface GoogleOAuthProvider {
  readonly isConfigured: boolean;
  /** Names of the environment variables that still need a value. */
  readonly missingConfig: string[];
  buildAuthorizationUrl(params: AuthorizationParams): string;
  /** Exchange the authorization code and return the *verified* ID-token claims. */
  exchangeCode(input: { code: string; codeVerifier: string }): Promise<GoogleIdentity>;
}

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";

export class UnconfiguredGoogleProvider implements GoogleOAuthProvider {
  readonly isConfigured = false;
  readonly missingConfig = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_CALLBACK_URL"];
  buildAuthorizationUrl(): string {
    throw new Error("Google OAuth is not configured.");
  }
  exchangeCode(): Promise<GoogleIdentity> {
    return Promise.reject(new Error("Google OAuth is not configured."));
  }
}

/** Production implementation using Google's official `google-auth-library`. */
export class GoogleAuthLibraryProvider implements GoogleOAuthProvider {
  readonly isConfigured = true;
  readonly missingConfig: string[] = [];
  private readonly client: OAuth2Client;

  constructor(private readonly google: NonNullable<AppConfig["google"]>) {
    this.client = new OAuth2Client({
      clientId: google.clientId,
      clientSecret: google.clientSecret,
      redirectUri: google.callbackUrl,
    });
  }

  buildAuthorizationUrl(params: AuthorizationParams): string {
    const url = new URL(AUTH_ENDPOINT);
    url.searchParams.set("client_id", this.google.clientId);
    url.searchParams.set("redirect_uri", this.google.callbackUrl);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "openid email profile");
    url.searchParams.set("state", params.state);
    url.searchParams.set("nonce", params.nonce);
    url.searchParams.set("code_challenge", params.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("access_type", "online");
    url.searchParams.set("prompt", "select_account");
    // `hd` is only a UI hint; the server re-validates the domain from the signed ID token.
    if (params.hostedDomainHint) url.searchParams.set("hd", params.hostedDomainHint);
    return url.toString();
  }

  async exchangeCode(input: { code: string; codeVerifier: string }): Promise<GoogleIdentity> {
    const { tokens } = await this.client.getToken({
      code: input.code,
      codeVerifier: input.codeVerifier,
      redirect_uri: this.google.callbackUrl,
    });
    if (!tokens.id_token) throw new Error("Google did not return an ID token.");
    // Verifies signature, issuer, audience and expiry.
    const ticket = await this.client.verifyIdToken({ idToken: tokens.id_token, audience: this.google.clientId });
    const payload = ticket.getPayload();
    if (!payload?.sub || !payload.email) throw new Error("ID token is missing required claims.");
    return {
      sub: payload.sub,
      email: payload.email,
      emailVerified: payload.email_verified === true,
      name: payload.name?.trim() || payload.email.split("@")[0] || "Participant",
      picture: payload.picture,
      hostedDomain: payload.hd,
      nonce: payload.nonce,
    };
  }
}

export function createGoogleProvider(google: AppConfig["google"]): GoogleOAuthProvider {
  return google ? new GoogleAuthLibraryProvider(google) : new UnconfiguredGoogleProvider();
}
