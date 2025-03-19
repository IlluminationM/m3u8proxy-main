import url from "node:url";
import parseURL from "./parseURL.js";
import withCORS from "./withCORS.js";

const userAgents = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.114 Safari/537.36"
];

export function onProxyResponse(proxy, proxyReq, proxyRes, req, res) {
  const requestState = req.corsAnywhereRequestState;
  const statusCode = proxyRes.statusCode;

  if (!requestState.redirectCount_) {
    res.setHeader("x-request-url", requestState.location.href);
  }

  if (statusCode === 403 && requestState.attempts < requestState.maxAttempts) {
    requestState.attempts++;
    proxyReq.abort();
    
    req.headers["user-agent"] = userAgents[requestState.attempts % userAgents.length];
    req.headers["accept"] = "*/*";
    req.headers["accept-language"] = "en-US,en;q=0.9";
    req.headers["cache-control"] = "no-cache";
    
    proxyRequest(req, res, proxy);
    return false;
  }

  if (
    statusCode === 301 ||
    statusCode === 302 ||
    statusCode === 303 ||
    statusCode === 307 ||
    statusCode === 308
  ) {
    let locationHeader = proxyRes.headers.location;
    let parsedLocation;
    if (locationHeader) {
      locationHeader = url.resolve(requestState.location.href, locationHeader);
      parsedLocation = parseURL(locationHeader);
    }
    if (parsedLocation) {
      if (statusCode === 301 || statusCode === 302 || statusCode === 303) {
        requestState.redirectCount_ = requestState.redirectCount_ + 1 || 1;
        if (requestState.redirectCount_ <= requestState.maxRedirects) {
          res.setHeader(
            "X-CORS-Redirect-" + requestState.redirectCount_,
            statusCode + " " + locationHeader
          );

          req.method = "GET";
          req.headers["content-length"] = "0";
          delete req.headers["content-type"];
          requestState.location = parsedLocation;
          req.removeAllListeners();
          proxyReq.removeAllListeners("error");
          proxyReq.once("error", function catchAndIgnoreError() {});
          proxyReq.abort();
          proxyRequest(req, res, proxy);
          return false;
        }
      }
      proxyRes.headers.location =
        requestState.proxyBaseUrl + "/" + locationHeader;
    }
  }

  delete proxyRes.headers["set-cookie"];
  delete proxyRes.headers["set-cookie2"];

  proxyRes.headers["x-final-url"] = requestState.location.href;
  withCORS(proxyRes.headers, req);
  return true;
}

export function proxyRequest(req, res, proxy) {
  const location = req.corsAnywhereRequestState.location;
  req.url = location.path;

  const proxyOptions = {
    changeOrigin: true,
    prependPath: false,
    target: location,
    headers: {
      host: location.host,
      "user-agent": req.headers["user-agent"] || userAgents[0],
      "accept": "*/*",
      "accept-language": "en-US,en;q=0.9",
      "referer": req.headers.referer || location.href
    },
    buffer: {
      pipe: function (proxyReq) {
        const proxyReqOn = proxyReq.on;
        proxyReq.on = function (eventName, listener) {
          if (eventName !== "response") {
            return proxyReqOn.call(this, eventName, listener);
          }
          return proxyReqOn.call(this, "response", function (proxyRes) {
            if (onProxyResponse(proxy, proxyReq, proxyRes, req, res)) {
              try {
                listener(proxyRes);
              } catch (err) {
                proxyReq.emit("error", err);
              }
            }
          });
        };
        return req.pipe(proxyReq);
      },
    },
  };

  try {
    proxy.web(req, res, proxyOptions);
  } catch (err) {
    res.writeHead(500, { "Access-Control-Allow-Origin": "*" });
    res.end("Proxy error: " + err.message);
  }
}