const SOUNDCLOUD_TOKEN_URL = "https://secure.soundcloud.com/oauth/token";
const SOUNDCLOUD_REDIRECT_URI = "viviette://soundcloud/callback";
const MAX_BODY_BYTES = 8192;

function reply(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "pragma": "no-cache",
      "x-content-type-options": "nosniff",
    },
  });
}

function error(message, status) {
  return reply({ error: message }, status);
}

function requiredString(body, key, maxLength = 4096) {
  const value = body[key];
  return typeof value === "string" && value.length > 0 && value.length <= maxLength
    ? value
    : null;
}

async function readSmallBody(request) {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/oauth/token") return error("Not found.", 404);
    if (request.method !== "POST") return error("Method not allowed.", 405);

    const contentLength = Number(request.headers.get("content-length") || "0");
    if (contentLength > MAX_BODY_BYTES) return error("Request too large.", 413);
    if (!request.headers.get("content-type")?.startsWith("application/json")) {
      return error("Expected a JSON request.", 415);
    }

    let body;
    try {
      const raw = await readSmallBody(request);
      if (raw === null) return error("Request too large.", 413);
      body = JSON.parse(raw);
    } catch {
      return error("Invalid request.", 400);
    }

    if (!env.SOUNDCLOUD_CLIENT_ID || !env.SOUNDCLOUD_CLIENT_SECRET) {
      return error("SoundCloud token service is not configured.", 503);
    }
    if (requiredString(body, "client_id", 256) !== env.SOUNDCLOUD_CLIENT_ID) {
      return error("Invalid client.", 400);
    }

    const grantType = body.grant_type;
    const form = new URLSearchParams({
      grant_type: typeof grantType === "string" ? grantType : "",
      client_id: env.SOUNDCLOUD_CLIENT_ID,
      client_secret: env.SOUNDCLOUD_CLIENT_SECRET,
    });

    if (grantType === "authorization_code") {
      const code = requiredString(body, "code", 4096);
      const redirectUri = requiredString(body, "redirect_uri", 512);
      const verifier = requiredString(body, "code_verifier", 256);
      if (!code || redirectUri !== SOUNDCLOUD_REDIRECT_URI || !verifier) {
        return error("Invalid authorization request.", 400);
      }
      form.set("code", code);
      form.set("redirect_uri", redirectUri);
      form.set("code_verifier", verifier);
    } else if (grantType === "refresh_token") {
      const refreshToken = requiredString(body, "refresh_token", 4096);
      if (!refreshToken) return error("Invalid refresh request.", 400);
      form.set("refresh_token", refreshToken);
    } else {
      return error("Unsupported grant type.", 400);
    }

    try {
      const tokenResponse = await fetch(SOUNDCLOUD_TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form.toString(),
        redirect: "error",
      });
      const tokenBody = await tokenResponse.text();
      return new Response(tokenBody, {
        status: tokenResponse.status,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
          "pragma": "no-cache",
          "x-content-type-options": "nosniff",
        },
      });
    } catch {
      return error("SoundCloud token exchange is temporarily unavailable.", 502);
    }
  },
};
