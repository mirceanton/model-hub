import * as client from "openid-client";
import type { FastifyInstance } from "fastify";
import { SESSION_COOKIE_NAME } from "../../auth/constants.js";
import { readSessionCookie } from "../../auth/cookie.js";
import { consumePendingAuth, createPendingAuth, getOidcClient } from "../../auth/oidc.js";
import { createSession, deleteSession, ensureLocalOwner, upsertOidcUser } from "../../auth/session.js";
import type { Config } from "../../config.js";
import type { DbClient } from "../../db/client.js";
import type { UserRow } from "../../db/schema.js";
import { ensureAuthSettings } from "../../lib/auth-settings.js";
import { authRateLimit } from "../../lib/rate-limit.js";

function toPublicUser(user: UserRow) {
  return { id: user.id, name: user.name, email: user.email, role: user.role };
}

/** Reads the configurable groups claim (see auth-settings.ts) off the ID token claims. Tolerant of it being absent or not an array of strings — resolves to []. */
function extractGroups(claims: Record<string, unknown>, groupsClaim: string): string[] {
  const raw = claims[groupsClaim];
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === "string");
}

export function registerAuthRoutes(app: FastifyInstance, db: DbClient, config: Config): void {
  app.get("/api/auth/me", async (request) => {
    if (!config.oidc) {
      return { authenticated: true, user: toPublicUser(ensureLocalOwner(db)), oidcEnabled: false };
    }
    return {
      authenticated: request.user != null,
      user: request.user ? toPublicUser(request.user) : null,
      oidcEnabled: true,
    };
  });

  if (!config.oidc) return;
  const oidcConfig = config.oidc;
  const authRouteOptions = { config: { rateLimit: authRateLimit(config) } };

  app.get("/auth/login", authRouteOptions, async (_request, reply) => {
    const oidc = getOidcClient();
    const codeVerifier = client.randomPKCECodeVerifier();
    const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
    const state = client.randomState();
    const nonce = client.randomNonce();
    createPendingAuth(state, codeVerifier, nonce);

    const authUrl = client.buildAuthorizationUrl(oidc, {
      redirect_uri: oidcConfig.redirectUrl,
      scope: "openid profile email",
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      state,
      nonce,
    });

    return reply.redirect(authUrl.toString());
  });

  app.get<{ Querystring: { state?: string } }>("/auth/callback", authRouteOptions, async (request, reply) => {
    const stateParam = request.query.state;
    const pending = stateParam ? consumePendingAuth(stateParam) : null;
    if (!pending) {
      return reply.code(400).send({ error: "invalid or expired login attempt" });
    }

    try {
      const oidc = getOidcClient();
      const currentUrl = new URL(request.url, oidcConfig.redirectUrl);
      const tokens = await client.authorizationCodeGrant(oidc, currentUrl, {
        pkceCodeVerifier: pending.codeVerifier,
        expectedState: stateParam,
        expectedNonce: pending.nonce,
      });

      const claims = tokens.claims();
      if (!claims?.sub) {
        throw new Error("ID token missing sub claim");
      }

      const { oidcGroupsClaim } = ensureAuthSettings(db);
      const user = upsertOidcUser(db, {
        sub: claims.sub,
        email: typeof claims.email === "string" ? claims.email : undefined,
        name: typeof claims.name === "string" ? claims.name : undefined,
        groups: extractGroups(claims, oidcGroupsClaim),
      });

      const session = createSession(db, user.id);
      reply.setCookie(SESSION_COOKIE_NAME, session.id, {
        path: "/",
        httpOnly: true,
        sameSite: "lax",
        secure: request.protocol === "https",
        expires: session.expiresAt,
        signed: true,
      });

      return reply.redirect("/");
    } catch (err) {
      request.log.error(err, "OIDC callback failed");
      return reply.code(400).send({ error: "login failed" });
    }
  });

  app.post("/auth/logout", authRouteOptions, async (request, reply) => {
    const sessionId = readSessionCookie(request);
    if (sessionId) {
      deleteSession(db, sessionId);
      reply.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
    }
    return reply.code(204).send();
  });
}
