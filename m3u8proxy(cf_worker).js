addEventListener("fetch", (event) => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  const url = new URL(request.url);

  // Handle different endpoints
  if (url.pathname === "/m3u8-proxy") {
    return handleM3U8Proxy(request);
  } else if (url.pathname === "/ts-proxy") {
    return handleTsProxy(request);
  } else if (url.pathname === "/") {
    return serveIndexPage();
  }

  return new Response("Not Found", { status: 404 });
}

// Configuration options (customize via Cloudflare Workers environment variables if needed)
const options = {
  originBlacklist: [], // e.g., ["http://blocked.com"]
  originWhitelist: ["*"], // "*" allows all origins
  rateLimit: "100 1", // 100 requests per 1 minute
};

// Rate limiting logic
function createRateLimitChecker(rateLimitConfig) {
  const [maxRequests, periodInMinutes] = rateLimitConfig.split(" ").map(Number);
  const periodInMs = periodInMinutes * 60 * 1000;
  const accessedHosts = new Map();

  // Reset if the period has expired (simulated, since Workers lack setInterval)
  const resetIfExpired = (host) => {
    const now = Date.now();
    const entry = accessedHosts.get(host);
    if (entry && now - entry.timestamp >= periodInMs) {
      accessedHosts.delete(host);
    }
  };

  return (origin) => {
    if (!origin) return null;
    const host = origin.replace(/^https?:\/\//i, "");
    resetIfExpired(host);

    let count = accessedHosts.get(host)?.count || 0;
    count += 1;

    if (count > maxRequests) {
      return `Rate limit exceeded: ${maxRequests} requests per ${periodInMinutes} minute${periodInMinutes === 1 ? "" : "s"}.`;
    }

    accessedHosts.set(host, { count, timestamp: Date.now() });
    return null;
  };
}

const checkRateLimit = createRateLimitChecker(options.rateLimit);

// Origin validation
const isOriginAllowed = (origin) => {
  if (options.originWhitelist.includes("*")) return true;
  if (options.originWhitelist.length && !options.originWhitelist.includes(origin)) return false;
  if (options.originBlacklist.length && options.originBlacklist.includes(origin)) return false;
  return true;
};

// Handle M3U8 proxy requests
async function handleM3U8Proxy(request) {
  const { searchParams } = new URL(request.url);
  const targetUrl = searchParams.get("url");
  const headersParam = searchParams.get("headers") || "{}";
  let headers;
  try {
    headers = JSON.parse(headersParam);
  } catch (e) {
    return new Response("Invalid headers format", { status: 400 });
  }
  const origin = request.headers.get("Origin") || "";

  if (!isOriginAllowed(origin)) {
    return new Response(`The origin "${origin}" is not allowed.`, { status: 403 });
  }

  const rateLimitMessage = checkRateLimit(origin);
  if (rateLimitMessage) {
    return new Response(rateLimitMessage, { status: 429 });
  }

  if (!targetUrl) {
    return new Response("URL parameter is required", { status: 400 });
  }

  try {
    const response = await fetch(targetUrl, { headers });
    if (!response.ok) {
      return new Response(`Failed to fetch M3U8: ${response.statusText}`, {
        status: response.status,
      });
    }

    let m3u8 = await response.text();
    m3u8 = m3u8
      .split("\n")
      .filter((line) => !line.startsWith("#EXT-X-MEDIA:TYPE=AUDIO"))
      .join("\n");

    const lines = m3u8.split("\n");
    const newLines = [];
    const baseUrl = new URL(request.url).origin;

    lines.forEach((line) => {
      if (line.startsWith("#")) {
        if (line.startsWith("#EXT-X-KEY:")) {
          const regex = /https?:\/\/[^"\s]+/g;
          const keyUrl = regex.exec(line)?.[0] ?? "";
          if (keyUrl) {
            const newUrl = `${baseUrl}/ts-proxy?url=${encodeURIComponent(keyUrl)}&headers=${encodeURIComponent(JSON.stringify(headers))}`;
            newLines.push(line.replace(keyUrl, newUrl));
          } else {
            newLines.push(line);
          }
        } else {
          newLines.push(line);
        }
      } else if (line.trim()) {
        const uri = new URL(line, targetUrl).href;
        newLines.push(
          `${baseUrl}/ts-proxy?url=${encodeURIComponent(uri)}&headers=${encodeURIComponent(JSON.stringify(headers))}`
        );
      }
    });

    return new Response(newLines.join("\n"), {
      headers: {
        "Content-Type": "application/vnd.apple.mpegurl",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "*",
        "Access-Control-Allow-Methods": "*",
      },
    });
  } catch (error) {
    return new Response(`Error: ${error.message}`, { status: 500 });
  }
}

// Handle TS proxy requests
async function handleTsProxy(request) {
  const { searchParams } = new URL(request.url);
  const targetUrl = searchParams.get("url");
  const headersParam = searchParams.get("headers") || "{}";
  let headers;
  try {
    headers = JSON.parse(headersParam);
  } catch (e) {
    return new Response("Invalid headers format", { status: 400 });
  }
  const origin = request.headers.get("Origin") || "";

  if (!isOriginAllowed(origin)) {
    return new Response(`The origin "${origin}" is not allowed.`, { status: 403 });
  }

  const rateLimitMessage = checkRateLimit(origin);
  if (rateLimitMessage) {
    return new Response(rateLimitMessage, { status: 429 });
  }

  if (!targetUrl) {
    return new Response("URL parameter is required", { status: 400 });
  }

  try {
    const response = await fetch(targetUrl, {
      method: request.method,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/80.0.3987.132 Safari/537.36",
        ...headers,
      },
    });

    if (!response.ok) {
      return new Response(`Failed to fetch segment: ${response.statusText}`, {
        status: response.status,
      });
    }

    return new Response(response.body, {
      status: response.status,
      headers: {
        "Content-Type": "video/mp2t",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "*",
        "Access-Control-Allow-Methods": "*",
      },
    });
  } catch (error) {
    return new Response(`Error: ${error.message}`, { status: 500 });
  }
}

// Serve a basic index page for testing
function serveIndexPage() {
  const html = `
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>M3U8 Proxy</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 20px; }
          .input-group { margin-bottom: 10px; }
          input { width: 100%; max-width: 400px; padding: 5px; }
          button { padding: 5px 10px; margin-right: 10px; }
          #result { margin-top: 20px; word-break: break-all; }
          video { width: 100%; max-width: 600px; margin-top: 20px; }
        </style>
      </head>
      <body>
        <h1>M3U8 Proxy</h1>
        <div class="input-group">
          <label for="url">URL</label>
          <input type="text" id="url" placeholder="Enter M3U8 URL" />
        </div>
        <div class="input-group">
          <label for="referer">Referer</label>
          <input type="text" id="referer" placeholder="Enter Referer URL (optional)" />
        </div>
        <button onclick="play()">Play</button>
        <button onclick="clearFields()">Clear</button>
        <div id="result"></div>
        <video id="player" controls></video>
        <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
        <script>
          let hls;
          function play() {
            const url = document.getElementById("url").value;
            const referer = document.getElementById("referer").value;
            const headers = referer ? { referer } : {};
            const headersString = encodeURIComponent(JSON.stringify(headers));
            const proxiedUrl = "/m3u8-proxy?url=" + encodeURIComponent(url) + "&headers=" + headersString;
            document.getElementById("result").innerHTML = "Proxied URL: <a href='" + proxiedUrl + "' target='_blank'>" + proxiedUrl + "</a>";
            
            const video = document.getElementById("player");
            if (hls) hls.destroy();
            if (Hls.isSupported()) {
              hls = new Hls();
              hls.loadSource(proxiedUrl);
              hls.attachMedia(video);
              hls.on(Hls.Events.MANIFEST_PARSED, () => video.play());
            } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
              video.src = proxiedUrl;
              video.addEventListener("loadedmetadata", () => video.play());
            }
          }
          function clearFields() {
            document.getElementById("url").value = "";
            document.getElementById("referer").value = "";
            document.getElementById("result").innerHTML = "";
            if (hls) hls.destroy();
            document.getElementById("player").src = "";
          }
        </script>
      </body>
    </html>
  `;
  return new Response(html, {
    headers: { "Content-Type": "text/html" },
  });
}