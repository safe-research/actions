const dns = require("node:dns");
const https = require("node:https");
const net = require("node:net");

const { truncate, MAX_OUTPUT_BYTES } = require("./tools.js");

const FETCH_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_REDIRECTS = 5;
const USER_AGENT = "safe-research-ai-review (+https://github.com/safe-research/actions)";
// `*` in the allowlist allows every public hostname.
const ANY_HOST = "*";
// Names that only resolve inside a local network; blocked in addition to the configured blocklist.
const ALWAYS_BLOCKED_DOMAINS = ["localhost", "local", "internal", "home.arpa"];

// Addresses that aren't reachable on the public internet: loopback, private networks, link-local, the shared
// address space used by Tailscale (100.64.0.0/10, fd7a:115c:a1e0::/48), documentation, multicast and reserved
// ranges, and IPv6 prefixes that embed an IPv4 address. IPv4-mapped IPv6 addresses are checked against the IPv4 rules.
const NON_PUBLIC_ADDRESSES = new net.BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
]) {
  NON_PUBLIC_ADDRESSES.addSubnet(address, prefix, "ipv4");
}
for (const [address, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 32],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
]) {
  NON_PUBLIC_ADDRESSES.addSubnet(address, prefix, "ipv6");
}

function isPublicAddress(address) {
  const family = net.isIP(address);
  if (family === 0) return false;
  return !NON_PUBLIC_ADDRESSES.check(address, family === 4 ? "ipv4" : "ipv6");
}

// Lowercases a hostname and drops the trailing dot of a fully qualified name, so `Example.com.` matches `example.com`.
function normalizeHost(host) {
  return host.toLowerCase().replace(/\.$/, "");
}

// Parses a comma- or whitespace-separated list of hostnames. Blocklist entries may be written as `*.example.com` or
// `.example.com`; they match the domain and all its subdomains either way.
function parseHostList(value) {
  return (value || "")
    .split(/[\s,]+/)
    .map((entry) => normalizeHost(entry.trim()).replace(/^\*?\./, ""))
    .filter(Boolean);
}

function isInDomain(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}

// Checks a URL against the fetch policy without resolving it: HTTPS on the default port, no credentials, a hostname
// (not an IP address) with at least one dot that is allowed and not blocked. Returns the parsed URL.
function checkUrl(url, { allowedHosts, blockedHosts }) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`invalid URL: ${url}`);
  }
  if (parsed.protocol !== "https:") throw new Error(`only https URLs are allowed: ${url}`);
  if (parsed.username || parsed.password) throw new Error(`URLs with credentials are not allowed: ${url}`);
  if (parsed.port) throw new Error(`only the default port is allowed: ${url}`);
  const host = normalizeHost(parsed.hostname);
  // The URL parser normalises IPv4 shorthands like `https://2130706433/` to `127.0.0.1`; IPv6 hosts keep brackets.
  if (net.isIP(host) || host.startsWith("[")) throw new Error(`IP addresses are not allowed, use a hostname: ${url}`);
  if (!host.includes(".")) throw new Error(`only fully qualified hostnames are allowed: ${url}`);
  if ([...ALWAYS_BLOCKED_DOMAINS, ...blockedHosts].some((domain) => isInDomain(host, domain))) {
    throw new Error(`host is blocked: ${host}`);
  }
  if (!allowedHosts.includes(ANY_HOST) && !allowedHosts.includes(host)) {
    throw new Error(`host is not in the allowlist: ${host}; allowed: ${allowedHosts.join(", ")}`);
  }
  return parsed;
}

// Wraps a `dns.lookup`-style function so that connections are only made to public addresses. The check runs on the
// addresses the socket actually connects to, so a hostname can't pass a separate check and then resolve elsewhere.
function publicOnlyLookup(lookup, isAllowedAddress) {
  return (hostname, options, callback) => {
    lookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err);
      const blocked = addresses.find(({ address }) => !isAllowedAddress(address));
      if (blocked) return callback(new Error(`${hostname} resolves to a non-public address (${blocked.address})`));
      if (addresses.length === 0) return callback(new Error(`${hostname} did not resolve`));
      if (options.all) return callback(null, addresses);
      callback(null, addresses[0].address, addresses[0].family);
    });
  };
}

// Decodes HTML entities in one pass, so `&amp;lt;` becomes `&lt;` and not `<`.
const NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function decodeEntities(text) {
  return text.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (entity, name) => {
    if (name[0] !== "#") return NAMED_ENTITIES[name.toLowerCase()] ?? entity;
    const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  });
}

// Reduces an HTML page to its text, so that documentation fits the output cap: drops comments, scripts, styles and
// the `<head>`, turns block elements into line breaks, removes the remaining tags and collapses whitespace and blank
// lines. Whitespace in `<pre>` blocks is kept, so code keeps its indentation.
function htmlToText(html) {
  const stripped = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<(head|script|style|noscript|template|svg)\b[\s\S]*?<\/\1\s*>/gi, "");
  // With a capturing group, `split` alternates between text outside (even indices) and inside (odd) `<pre>` blocks.
  const text = stripped
    .split(/(<pre\b[^>]*>[\s\S]*?<\/pre\s*>)/i)
    .map((part, i) => {
      if (i % 2 === 1) return `\n${part.replace(/<[^>]*>/g, "")}\n`;
      return part
        .replace(/\s+/g, " ")
        .replace(/<\/?(br|hr|p|div|section|article|header|footer|nav|main|aside|h[1-6]|li|ul|ol|dl|dt|dd|tr|table|blockquote|details|summary)\b[^>]*>/gi, "\n")
        .replace(/<[^>]*>/g, "")
        .replace(/ *\n */g, "\n");
    })
    .join("");
  return decodeEntities(text)
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Decodes the body as text in the charset from the Content-Type header, falling back to UTF-8.
function decodeText(buffer, contentType) {
  const charset = /charset="?([^";\s]+)/i.exec(contentType || "")?.[1];
  try {
    return new TextDecoder(charset || "utf-8").decode(buffer);
  } catch {
    return new TextDecoder("utf-8").decode(buffer);
  }
}

// Sends one GET request without following redirects and reads at most `maxResponseBytes` of the body.
function get(url, { transport, lookup, signal, maxResponseBytes }) {
  return new Promise((resolve, reject) => {
    const request = transport.get(
      {
        hostname: url.hostname,
        port: transport.port,
        path: `${url.pathname}${url.search}`,
        // No cookies or credentials, and no compression, so the size limit applies to the actual content.
        headers: { "User-Agent": USER_AGENT, Accept: "text/*, application/json;q=0.9, */*;q=0.8", "Accept-Encoding": "identity" },
        lookup,
        signal,
        agent: false,
      },
      (response) => {
        const chunks = [];
        let size = 0;
        let truncated = false;
        response.on("data", (chunk) => {
          if (truncated) return;
          chunks.push(chunk);
          size += chunk.length;
          if (size >= maxResponseBytes) {
            truncated = true;
            response.destroy();
            finish();
          }
        });
        response.on("end", () => finish());
        response.on("error", (err) => (truncated ? undefined : reject(err)));
        let done = false;
        function finish() {
          if (done) return;
          done = true;
          resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).subarray(0, maxResponseBytes), truncated });
        }
      },
    );
    request.on("error", reject);
  });
}

// Creates the `fetch_url` tool. `allowedHosts` are exact hostnames or `*` for any public hostname; `blockedHosts` are
// domains that are blocked with all their subdomains. `onRequest(message)` is called for every request (including
// redirects), so the job log shows what the agent fetched. `transport` and `isAllowedAddress` are only replaced in tests.
function createFetchTool({
  allowedHosts,
  blockedHosts = [],
  onRequest = () => {},
  maxOutputBytes = MAX_OUTPUT_BYTES,
  maxResponseBytes = MAX_RESPONSE_BYTES,
  timeoutMs = FETCH_TIMEOUT_MS,
  transport = { get: https.get, lookup: dns.lookup },
  isAllowedAddress = isPublicAddress,
}) {
  if (allowedHosts.length === 0) throw new Error("allowedHosts must not be empty");
  const policy = { allowedHosts, blockedHosts };
  const lookup = publicOnlyLookup(transport.lookup, isAllowedAddress);

  async function fetchUrl({ url, raw = false }) {
    if (typeof url !== "string") throw new Error("url must be a string");
    const signal = AbortSignal.timeout(timeoutMs);
    let current = checkUrl(url, policy);
    for (let redirects = 0; ; redirects++) {
      let response;
      try {
        response = await get(current, { transport, lookup, signal, maxResponseBytes });
      } catch (err) {
        onRequest(`GET ${current.href} failed: ${err.message}`);
        throw new Error(`GET ${current.href} failed: ${signal.aborted ? `timed out after ${timeoutMs} ms` : err.message}`);
      }
      onRequest(`GET ${current.href} -> ${response.status}`);
      const location = response.headers.location;
      if (response.status >= 300 && response.status < 400 && location) {
        if (redirects === MAX_REDIRECTS) throw new Error(`too many redirects, last: ${current.href} -> ${location}`);
        // Every hop is checked like the original URL.
        current = checkUrl(new URL(location, current).href, policy);
        continue;
      }
      const contentType = response.headers["content-type"] || "";
      let text = decodeText(response.body, contentType);
      if (!raw && /^\s*(text\/html|application\/xhtml\+xml)/i.test(contentType)) text = htmlToText(text);
      const header = [
        `URL: ${current.href}`,
        `Status: ${response.status}`,
        `Content-Type: ${contentType || "(none)"}`,
        ...(response.truncated ? [`Note: only the first ${maxResponseBytes} bytes of the response were read`] : []),
      ].join("\n");
      const output = `${header}\n\n${text}`;
      if (response.status >= 400) throw new Error(truncate(`HTTP ${response.status}\n${output}`, 2048));
      return truncate(output, maxOutputBytes);
    }
  }

  const scope = allowedHosts.includes(ANY_HOST) ? "any public host" : `these hosts: ${allowedHosts.join(", ")}`;
  const blocked = blockedHosts.length > 0 ? ` Blocked domains (including subdomains): ${blockedHosts.join(", ")}.` : "";
  return {
    name: "fetch_url",
    description:
      `HTTPS GET request to ${scope}, unauthenticated. Hostnames only (no IP addresses, no ports), and only hosts that resolve to public addresses.${blocked} ` +
      `Redirects are followed. The response is always returned as text, with a header giving the final URL, status and content type; HTML pages are converted to plain text unless raw is true.`,
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "https URL to fetch" },
        raw: { type: "boolean", description: "Return the HTML source instead of the extracted text (default false)" },
      },
      required: ["url"],
    },
    run: fetchUrl,
  };
}

module.exports = { ANY_HOST, createFetchTool, parseHostList, checkUrl, isPublicAddress, publicOnlyLookup, htmlToText, decodeEntities };
