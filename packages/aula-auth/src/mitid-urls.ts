/**
 * MitID URL builders. All endpoints live under `www.mitid.dk` /
 * `nemlog-in.mitid.dk`. Centralised here so a future host change is one diff.
 */

const MITID_HOST = 'https://www.mitid.dk';
const NEMLOGIN_HOST = 'https://nemlog-in.mitid.dk';

export const mitidUrls = {
  /** Get serviceProviderName + reference text + brokerSecurityContext for a session. */
  authenticationSession(sessionId: string): string {
    return `${MITID_HOST}/mitid-core-client-backend/v1/authentication-sessions/${encodeURIComponent(sessionId)}`;
  },

  /** Identity claim PUT and `next` POST share this base. */
  authenticationSessionNext(sessionId: string): string {
    return `${MITID_HOST}/mitid-core-client-backend/v2/authentication-sessions/${encodeURIComponent(sessionId)}/next`;
  },

  /** Finalization PUT — returns the OAuth authorization code. */
  finalization(sessionId: string): string {
    return `${MITID_HOST}/mitid-core-client-backend/v1/authentication-sessions/${encodeURIComponent(sessionId)}/finalization`;
  },

  // --- APP authenticator (newer "complete" path) ----------------------------

  appInitAuth(authenticatorSessionId: string): string {
    return `${MITID_HOST}/mitid-code-app-auth/v1/authenticator-sessions/web/${encodeURIComponent(authenticatorSessionId)}/init-auth`;
  },

  appInit(authenticatorSessionId: string): string {
    return `${MITID_HOST}/mitid-code-app-auth/v1/authenticator-sessions/web/${encodeURIComponent(authenticatorSessionId)}/init`;
  },

  appComplete(authenticatorSessionId: string): string {
    return `${MITID_HOST}/mitid-code-app-auth/v1/authenticator-sessions/web/${encodeURIComponent(authenticatorSessionId)}/complete`;
  },

  // --- APP authenticator (legacy /prove + /verify path) --------------------

  appProve(authenticatorSessionId: string): string {
    return `${MITID_HOST}/mitid-code-app-auth/v1/authenticator-sessions/web/${encodeURIComponent(authenticatorSessionId)}/prove`;
  },

  appVerify(authenticatorSessionId: string): string {
    return `${MITID_HOST}/mitid-code-app-auth/v1/authenticator-sessions/web/${encodeURIComponent(authenticatorSessionId)}/verify`;
  },

  // --- CODE_TOKEN authenticator --------------------------------------------

  codeTokenInit(authenticatorSessionId: string): string {
    return `${MITID_HOST}/mitid-code-token-auth/v1/authenticator-sessions/${encodeURIComponent(authenticatorSessionId)}/codetoken-init`;
  },

  codeTokenProve(authenticatorSessionId: string): string {
    return `${MITID_HOST}/mitid-code-token-auth/v1/authenticator-sessions/${encodeURIComponent(authenticatorSessionId)}/codetoken-prove`;
  },

  // --- PASSWORD authenticator ----------------------------------------------

  passwordInit(authenticatorSessionId: string): string {
    return `${MITID_HOST}/mitid-password-auth/v1/authenticator-sessions/${encodeURIComponent(authenticatorSessionId)}/init`;
  },

  passwordProve(authenticatorSessionId: string): string {
    return `${MITID_HOST}/mitid-password-auth/v1/authenticator-sessions/${encodeURIComponent(authenticatorSessionId)}/password-prove`;
  },

  // --- nemlog-in (the SAML wrapper around MitID) ---------------------------

  loginMitid: `${NEMLOGIN_HOST}/login/mitid`,
  loginMitidInitialize: `${NEMLOGIN_HOST}/login/mitid/initialize`,
  loginOption: `${NEMLOGIN_HOST}/loginoption`,
};
