// WebAuthn browser-side ceremonies, shared by login.html and settings.html.
//
// Hand-rolled rather than pulling in @simplewebauthn/browser: the only thing
// that library really does here is base64url <-> ArrayBuffer conversion, and
// vendoring a bundle into a no-build frontend costs more than these 30 lines.
//
// @simplewebauthn/server v13 emits challenge / user.id / credential ids as
// base64url STRINGS, while navigator.credentials wants ArrayBuffers - and hands
// ArrayBuffers back, which must be re-encoded for the JSON response. Every
// conversion below exists for that boundary.

function b64urlToBuf(s){
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf;
}
function bufToB64url(buf){
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function postJson(url, body){
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

function passkeySupported(){
  return !!(window.PublicKeyCredential && navigator.credentials && navigator.credentials.create);
}

// Registers this device as a passkey. Enrolling the FIRST one also switches
// enforcement on server-side, so this is the moment the dashboard closes.
async function registerPasskey(label){
  if (!passkeySupported()) throw new Error('this browser has no WebAuthn support');
  const { challengeId, options } = await postJson('/api/auth/register/options', {});

  options.challenge = b64urlToBuf(options.challenge);
  options.user.id = b64urlToBuf(options.user.id);
  if (options.excludeCredentials){
    options.excludeCredentials = options.excludeCredentials.map(c => ({ ...c, id: b64urlToBuf(c.id) }));
  }

  const cred = await navigator.credentials.create({ publicKey: options });
  if (!cred) throw new Error('registration was cancelled');

  return postJson('/api/auth/register/verify', {
    challengeId,
    label: label || undefined,
    response: {
      id: cred.id,
      rawId: bufToB64url(cred.rawId),
      type: cred.type,
      clientExtensionResults: cred.getClientExtensionResults(),
      response: {
        clientDataJSON: bufToB64url(cred.response.clientDataJSON),
        attestationObject: bufToB64url(cred.response.attestationObject),
        transports: cred.response.getTransports ? cred.response.getTransports() : [],
      },
    },
  });
}

// Signs in. allowCredentials is empty server-side and the credentials are
// discoverable, so the device offers whatever passkey it holds for this origin
// and no username is ever typed.
async function loginWithPasskey(){
  if (!passkeySupported()) throw new Error('this browser has no WebAuthn support');
  const { challengeId, options } = await postJson('/api/auth/login/options', {});

  options.challenge = b64urlToBuf(options.challenge);
  if (options.allowCredentials && options.allowCredentials.length){
    options.allowCredentials = options.allowCredentials.map(c => ({ ...c, id: b64urlToBuf(c.id) }));
  } else {
    delete options.allowCredentials;
  }

  const cred = await navigator.credentials.get({ publicKey: options });
  if (!cred) throw new Error('sign-in was cancelled');

  return postJson('/api/auth/login/verify', {
    challengeId,
    response: {
      id: cred.id,
      rawId: bufToB64url(cred.rawId),
      type: cred.type,
      clientExtensionResults: cred.getClientExtensionResults(),
      response: {
        clientDataJSON: bufToB64url(cred.response.clientDataJSON),
        authenticatorData: bufToB64url(cred.response.authenticatorData),
        signature: bufToB64url(cred.response.signature),
        userHandle: cred.response.userHandle ? bufToB64url(cred.response.userHandle) : null,
      },
    },
  });
}

// Sends any expired/absent session straight to the login page rather than
// letting pages fail silently with half-rendered data. Wrapping fetch once here
// avoids touching the couple of hundred existing call sites; /api/auth/* is
// exempt or the login page could never talk to the server. Skipped on the login
// page itself to avoid a redirect loop.
(function interceptUnauthorized(){
  if (location.pathname.endsWith('/login.html')) return;
  const realFetch = window.fetch;
  window.fetch = async function(...args){
    const res = await realFetch.apply(this, args);
    const url = String(args[0] || '');
    if (res.status === 401 && url.includes('/api/') && !url.includes('/api/auth/')){
      const next = encodeURIComponent(location.pathname + location.search);
      location.href = `/login.html?next=${next}`;
    }
    return res;
  };
})();
