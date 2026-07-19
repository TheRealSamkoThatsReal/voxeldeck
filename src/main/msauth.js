'use strict';

/**
 * Microsoft account authentication for launching Minecraft — the same flow the
 * official launcher and Prism/MultiMC use, so you play with an account that
 * actually owns the game. We use the OAuth 2.0 *device code* grant: the app
 * shows a short code, the user enters it at microsoft.com/link in their browser,
 * and we poll for the token. From there the chain is:
 *
 *   MSA token → Xbox Live → XSTS → Minecraft services token → profile (name+uuid)
 *
 * ── SETUP (required for live logins) ─────────────────────────────────────────
 * Microsoft only issues Minecraft-scoped tokens to an Azure AD application that
 * the project owner has registered. Create one at https://portal.azure.com →
 * "App registrations":
 *   • Supported account types: "Personal Microsoft accounts only"
 *   • Authentication → Advanced → "Allow public client flows" = Yes
 *   • (No redirect URI needed for the device-code flow.)
 * Then request Minecraft API access as described at
 * https://help.minecraft.net/hc/en-us/articles/16254801392141 and put the
 * Application (client) ID below (or set the VOXELDECK_MS_CLIENT_ID env var).
 * Until that's done, `isConfigured()` returns false and the UI explains it.
 * ─────────────────────────────────────────────────────────────────────────────
 */

// Replace with your Azure app's Application (client) ID, or set VOXELDECK_MS_CLIENT_ID.
const CLIENT_ID = process.env.VOXELDECK_MS_CLIENT_ID || 'REPLACE_WITH_YOUR_AZURE_CLIENT_ID';

const SCOPE = 'XboxLive.signin offline_access';
const DEVICECODE_URL = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode';
const TOKEN_URL = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token';
const XBL_URL = 'https://user.auth.xboxlive.com/user/authenticate';
const XSTS_URL = 'https://xsts.auth.xboxlive.com/xsts/authorize';
const MC_LOGIN_URL = 'https://api.minecraftservices.com/authentication/login_with_xbox';
const MC_PROFILE_URL = 'https://api.minecraftservices.com/minecraft/profile';

const JSON_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json' };

function isConfigured() {
  return typeof CLIENT_ID === 'string' && CLIENT_ID.startsWith('REPLACE_WITH_') === false && CLIENT_ID.length > 10;
}

async function postForm(url, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString()
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

async function postJson(url, obj, extraHeaders = {}) {
  const res = await fetch(url, { method: 'POST', headers: { ...JSON_HEADERS, ...extraHeaders }, body: JSON.stringify(obj) });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run the device-code login. Calls onCode(info) once with the code the user must
 * enter, then polls until they finish (or it's cancelled/expires). `shouldCancel`
 * is an optional predicate polled between attempts. Resolves to a full account.
 */
async function startDeviceLogin(onCode, shouldCancel = () => false) {
  if (!isConfigured()) {
    throw new Error('Microsoft login isn’t configured yet: add an Azure app client ID (see msauth.js / docs).');
  }

  const dc = await postForm(DEVICECODE_URL, { client_id: CLIENT_ID, scope: SCOPE });
  if (!dc.ok) throw new Error(dc.body.error_description || 'Could not start Microsoft login.');
  const { device_code, user_code, verification_uri, expires_in } = dc.body;
  let interval = (dc.body.interval || 5) * 1000;

  if (onCode) onCode({ userCode: user_code, verificationUri: verification_uri || 'https://microsoft.com/link', expiresIn: expires_in, message: dc.body.message });

  const deadline = Date.now() + (expires_in || 900) * 1000;
  for (;;) {
    if (shouldCancel()) throw new Error('Login cancelled.');
    if (Date.now() > deadline) throw new Error('Login timed out — the code expired. Try again.');
    await sleep(interval);

    const tok = await postForm(TOKEN_URL, {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: CLIENT_ID,
      device_code
    });
    if (tok.ok) {
      return finishFromMsa(tok.body.access_token, tok.body.refresh_token);
    }
    const err = tok.body.error;
    if (err === 'authorization_pending') continue;
    if (err === 'slow_down') { interval += 5000; continue; }
    if (err === 'authorization_declined') throw new Error('Login was declined.');
    if (err === 'expired_token') throw new Error('The login code expired. Try again.');
    throw new Error(tok.body.error_description || 'Microsoft login failed.');
  }
}

/** Exchange an MSA access token for a full Minecraft account (+profile). */
async function finishFromMsa(msAccessToken, msRefreshToken) {
  // 1) Xbox Live user token.
  const xbl = await postJson(XBL_URL, {
    Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: `d=${msAccessToken}` },
    RelyingParty: 'http://auth.xboxlive.com',
    TokenType: 'JWT'
  });
  if (!xbl.ok) throw new Error('Xbox Live authentication failed.');
  const xblToken = xbl.body.Token;

  // 2) XSTS token (authorizes the Minecraft relying party).
  const xsts = await postJson(XSTS_URL, {
    Properties: { SandboxId: 'RETAIL', UserTokens: [xblToken] },
    RelyingParty: 'rp://api.minecraftservices.com/',
    TokenType: 'JWT'
  });
  if (!xsts.ok) {
    const xerr = xsts.body && xsts.body.XErr;
    const map = {
      2148916233: 'This Microsoft account has no Xbox profile — sign in once at xbox.com first.',
      2148916235: 'Xbox Live isn’t available in this account’s region.',
      2148916236: 'Adult verification is required for this account.',
      2148916238: 'This is a child account — it must be added to a Family by an adult first.'
    };
    throw new Error(map[xerr] || 'Xbox (XSTS) authorization failed.');
  }
  const xstsToken = xsts.body.Token;
  const uhs = xsts.body.DisplayClaims.xui[0].uhs;
  const xuid = xsts.body.DisplayClaims.xui[0].xid || '';

  // 3) Minecraft services token.
  const mc = await postJson(MC_LOGIN_URL, { identityToken: `XBL3.0 x=${uhs};${xstsToken}` });
  if (!mc.ok) throw new Error('Minecraft authentication failed.');
  const accessToken = mc.body.access_token;
  const expiresAt = Date.now() + (mc.body.expires_in || 86400) * 1000;

  // 4) Profile (name + uuid). A 404 means this account doesn't own the game.
  const prof = await fetch(MC_PROFILE_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (prof.status === 404) throw new Error('This account doesn’t own Minecraft (Java Edition).');
  if (!prof.ok) throw new Error(`Could not load Minecraft profile (HTTP ${prof.status}).`);
  const profile = await prof.json();

  return {
    name: profile.name,
    uuid: profile.id,
    accessToken,
    xuid,
    userType: 'msa',
    msRefresh: msRefreshToken || null,
    expiresAt,
    updatedAt: Date.now()
  };
}

/** Refresh an account using its stored MSA refresh token. */
async function refreshAccount(account) {
  if (!account || !account.msRefresh) throw new Error('Please sign in to Microsoft again.');
  if (!isConfigured()) throw new Error('Microsoft login isn’t configured.');
  const tok = await postForm(TOKEN_URL, {
    grant_type: 'refresh_token',
    client_id: CLIENT_ID,
    scope: SCOPE,
    refresh_token: account.msRefresh
  });
  if (!tok.ok) throw new Error('Your Microsoft session expired — please sign in again.');
  return finishFromMsa(tok.body.access_token, tok.body.refresh_token || account.msRefresh);
}

/** Return a launch-ready account, refreshing the token first if it's near expiry. */
async function ensureFresh(account) {
  if (!account) throw new Error('No account — sign in to Microsoft first.');
  if (account.expiresAt && account.expiresAt - Date.now() > 5 * 60 * 1000) return account;
  return refreshAccount(account);
}

module.exports = { CLIENT_ID, isConfigured, startDeviceLogin, refreshAccount, ensureFresh };
