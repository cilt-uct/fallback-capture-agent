const crypto = require('crypto');

function md5(str) {
  return crypto.createHash('md5').update(str).digest('hex');
}

function parseDigestHeader(header) {
  const params = {};
  const regex = /(\w+)=(?:"([^"]*)"|([^,]+))/g;
  let match;
  while ((match = regex.exec(header)) !== null) {
    params[match[1]] = match[2] !== undefined ? match[2] : match[3].trim();
  }
  return params;
}

// Minimal HTTP Digest (RFC 7616) client built on the built-in `fetch`.
// Replaces `request` + `request-digest`, which are deprecated/unmaintained
// and pull in most of this app's critical npm audit findings.
function createDigestClient(username, password) {
  let cachedChallenge = null;
  let nonceCount = 0;

  function buildAuthHeader(method, uri, challenge) {
    const { realm, nonce, qop, opaque } = challenge;
    const ha1 = md5(`${username}:${realm}:${password}`);
    const ha2 = md5(`${method}:${uri}`);
    let response;
    let extra = '';

    if (qop) {
      nonceCount += 1;
      const nc = nonceCount.toString(16).padStart(8, '0');
      const cnonce = crypto.randomBytes(8).toString('hex');
      const usedQop = qop.split(',')[0].trim();
      response = md5(`${ha1}:${nonce}:${nc}:${cnonce}:${usedQop}:${ha2}`);
      extra = `, qop=${usedQop}, nc=${nc}, cnonce="${cnonce}"`;
    } else {
      response = md5(`${ha1}:${nonce}:${ha2}`);
    }

    return `Digest username="${username}", realm="${realm}", nonce="${nonce}", uri="${uri}"${extra}, response="${response}"` +
      (opaque ? `, opaque="${opaque}"` : '');
  }

  async function request(fullUrl, opts = {}) {
    const method = opts.method || 'GET';
    const headers = Object.assign({}, opts.headers);
    const { pathname, search } = new URL(fullUrl);
    const uri = pathname + search;

    if (cachedChallenge) {
      headers.Authorization = buildAuthHeader(method, uri, cachedChallenge);
    }

    let res = await fetch(fullUrl, { method, headers, body: opts.body });

    if (res.status === 401) {
      const authHeader = res.headers.get('www-authenticate');
      if (authHeader && /^Digest /i.test(authHeader)) {
        cachedChallenge = parseDigestHeader(authHeader.replace(/^Digest\s+/i, ''));
        headers.Authorization = buildAuthHeader(method, uri, cachedChallenge);
        res = await fetch(fullUrl, { method, headers, body: opts.body });
      }
    }

    return res;
  }

  return { request };
}

module.exports = { createDigestClient };
