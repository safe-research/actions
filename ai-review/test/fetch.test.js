const assert = require("node:assert/strict");
const http = require("node:http");
const { after, before, describe, it } = require("node:test");

const { createFetchTool, parseHostList, parseSources, checkUrl, isPublicAddress, publicOnlyLookup, htmlToText, decodeEntities } = require("../fetch.js");

const ANY = { allowedHosts: ["*"], blockedHosts: [] };

describe("parseHostList", () => {
  it("splits on commas and whitespace and normalizes entries", () => {
    assert.deepEqual(parseHostList("Docs.rs, registry.npmjs.org\napi.github.com.  *.ts.net,.internal.example"), [
      "docs.rs",
      "registry.npmjs.org",
      "api.github.com",
      "ts.net",
      "internal.example",
    ]);
    assert.deepEqual(parseHostList("*"), ["*"]);
    assert.deepEqual(parseHostList(""), []);
    assert.deepEqual(parseHostList(undefined), []);
  });
});

describe("parseSources", () => {
  const CONTEXT7 = "Library docs (Context7): search https://context7.com/api/v1/search?query=<library>, then fetch https://context7.com/api/v1/<library id>?type=txt&topic=<topic>&tokens=5000";
  const SAFE = "Safe protocol docs: https://docs.safefoundation.org/llms.txt (index), https://docs.safefoundation.org/llms-full.txt (all pages)";

  it("keeps lines with reachable URLs and skips empty lines and comments", () => {
    const skipped = [];
    const sources = parseSources(`\n  ${CONTEXT7}  \n# a comment\n\n${SAFE}\n`, ANY, (line, reason) => skipped.push([line, reason]));
    assert.deepEqual(sources, [CONTEXT7, SAFE]);
    assert.deepEqual(skipped, []);
    assert.deepEqual(parseSources("", ANY), []);
    assert.deepEqual(parseSources(undefined, ANY), []);
  });

  it("skips lines without an https URL or with a host that can't be fetched", () => {
    const skipped = [];
    const policy = { allowedHosts: ["context7.com", "internal.example"], blockedHosts: ["internal.example"] };
    const sources = parseSources(
      [CONTEXT7, SAFE, "Wiki: https://internal.example/wiki", "Docs: http://context7.com/", "Ask the team"].join("\n"),
      policy,
      (line, reason) => skipped.push(`${line.split(":")[0]}: ${reason}`),
    );
    assert.deepEqual(sources, [CONTEXT7]);
    assert.deepEqual(skipped, [
      "Safe protocol docs: host is not in the allowlist: docs.safefoundation.org; allowed: context7.com, internal.example",
      "Wiki: host is blocked: internal.example",
      "Docs: no https URL",
      "Ask the team: no https URL",
    ]);
  });
});

describe("checkUrl", () => {
  it("allows any public hostname with *", () => {
    assert.equal(checkUrl("https://docs.rs/serde/latest/serde/", ANY).hostname, "docs.rs");
    assert.equal(checkUrl("https://registry.npmjs.org/react/latest", ANY).hostname, "registry.npmjs.org");
  });

  it("only allows https on the default port without credentials", () => {
    assert.throws(() => checkUrl("http://docs.rs/", ANY), /only https/);
    assert.throws(() => checkUrl("file:///etc/passwd", ANY), /only https/);
    assert.throws(() => checkUrl("https://docs.rs:8443/", ANY), /default port/);
    assert.throws(() => checkUrl("https://user:pw@docs.rs/", ANY), /credentials/);
    assert.throws(() => checkUrl("not a url", ANY), /invalid URL/);
  });

  it("rejects IP addresses in any notation", () => {
    for (const url of ["https://127.0.0.1/", "https://2130706433/", "https://0x7f.1/", "https://[::1]/", "https://100.100.100.100/", "https://8.8.8.8/"]) {
      assert.throws(() => checkUrl(url, ANY), /IP addresses are not allowed/, url);
    }
  });

  it("rejects single-label and local names", () => {
    assert.throws(() => checkUrl("https://localhost/", ANY), /fully qualified/);
    assert.throws(() => checkUrl("https://my-server/", ANY), /fully qualified/);
    for (const url of ["https://foo.localhost/", "https://printer.local/", "https://metadata.google.internal/", "https://nas.home.arpa./"]) {
      assert.throws(() => checkUrl(url, ANY), /host is blocked/, url);
    }
  });

  it("blocks blocklisted domains and their subdomains", () => {
    const policy = { allowedHosts: ["*"], blockedHosts: ["ts.net", "corp.example"] };
    assert.throws(() => checkUrl("https://ts.net/", policy), /host is blocked: ts.net/);
    assert.throws(() => checkUrl("https://server.tail1234.ts.net/", policy), /host is blocked/);
    assert.throws(() => checkUrl("https://Wiki.Corp.Example./", policy), /host is blocked: wiki.corp.example/);
    assert.equal(checkUrl("https://notts.net/", policy).hostname, "notts.net");
  });

  it("matches allowlisted hosts exactly", () => {
    const policy = { allowedHosts: ["allowed.com"], blockedHosts: [] };
    assert.equal(checkUrl("https://allowed.com/x", policy).hostname, "allowed.com");
    assert.equal(checkUrl("https://ALLOWED.com./x", policy).hostname, "allowed.com.");
    for (const url of ["https://allowed.com.evil.com/", "https://allowed.com@evil.com/", "https://sub.allowed.com/", "https://evil.com/?allowed.com"]) {
      assert.throws(() => checkUrl(url, policy), /not in the allowlist|credentials/, url);
    }
  });
});

describe("isPublicAddress", () => {
  it("accepts public addresses", () => {
    for (const address of ["8.8.8.8", "140.82.112.3", "2606:4700::6810:84e5"]) assert.ok(isPublicAddress(address), address);
  });

  it("rejects private, local, tailnet and reserved addresses", () => {
    for (const address of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "100.100.100.100",
      "0.0.0.0",
      "224.0.0.1",
      "::1",
      "::",
      "fe80::1",
      "fd7a:115c:a1e0::1",
      "::ffff:127.0.0.1",
      "::ffff:100.101.102.103",
      "64:ff9b::a00:1",
      "not an address",
    ]) {
      assert.ok(!isPublicAddress(address), address);
    }
  });
});

describe("publicOnlyLookup", () => {
  const fakeLookup = (addresses) => (hostname, options, callback) => callback(null, addresses);

  it("passes public addresses on in both callback styles", async () => {
    const lookup = publicOnlyLookup(fakeLookup([{ address: "8.8.8.8", family: 4 }]), isPublicAddress);
    await new Promise((resolve) =>
      lookup("dns.example", { all: true }, (err, addresses) => {
        assert.ifError(err);
        assert.deepEqual(addresses, [{ address: "8.8.8.8", family: 4 }]);
        resolve();
      }),
    );
    await new Promise((resolve) =>
      lookup("dns.example", {}, (err, address, family) => {
        assert.ifError(err);
        assert.equal(address, "8.8.8.8");
        assert.equal(family, 4);
        resolve();
      }),
    );
  });

  it("fails if any resolved address is not public", async () => {
    const lookup = publicOnlyLookup(fakeLookup([{ address: "8.8.8.8", family: 4 }, { address: "100.100.1.2", family: 4 }]), isPublicAddress);
    await new Promise((resolve) =>
      lookup("rebind.example", { all: true }, (err) => {
        assert.match(err.message, /rebind.example resolves to a non-public address \(100.100.1.2\)/);
        resolve();
      }),
    );
  });
});

describe("htmlToText", () => {
  it("extracts the text of a page", () => {
    const html = `<!doctype html><html><head><title>t</title><style>body{}</style></head><body>
<nav><a href="/">Home</a></nav><!-- comment --><script>alert(1)</script>
<h1>Struct&nbsp;Foo</h1><p>Uses &lt;T&gt; &amp;amp; more &#x1F600; &#65;</p>
<pre><code>fn main() {
    run();
}</code></pre></body></html>`;
    assert.equal(htmlToText(html), "Struct Foo\n\nUses <T> &amp; more 😀 A\n\nfn main() {\n    run();\n}");
  });

  it("drops the site navigation and footer, and a script cut off at the end", () => {
    const html = `<body><header><h1>Title</h1></header><nav><ul><li>Menu</li></ul></nav><main>Content</main><aside>Note</aside><footer>© Site</footer>
<script>one()</script><p>More</p><script>let cut = "`;
    assert.equal(htmlToText(html), "Title\n\nContent\n\nNote\n\nMore");
  });

  it("keeps unknown entities", () => {
    assert.equal(decodeEntities("&unknown; &#0; &amp;lt;"), "&unknown; &#0; &lt;");
  });
});

describe("fetch_url", () => {
  let server, port;
  const routes = {
    "/text": (req, res) => res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }).end(`hello ${req.headers["user-agent"]} ${req.headers.authorization ?? "no-auth"}`),
    "/json": (req, res) => res.writeHead(200, { "Content-Type": "application/json" }).end('{"version":"1.2.3"}'),
    "/latin1": (req, res) => res.writeHead(200, { "Content-Type": "text/plain; charset=iso-8859-1" }).end(Buffer.from([0x63, 0x61, 0x66, 0xe9])),
    "/binary": (req, res) => res.writeHead(200, { "Content-Type": "application/octet-stream" }).end(Buffer.from("abc")),
    "/html": (req, res) => res.writeHead(200, { "Content-Type": "text/html" }).end("<html><body><h1>Title</h1><p>Body</p></body></html>"),
    "/big": (req, res) => res.writeHead(200, { "Content-Type": "text/plain" }).end("x".repeat(10_000)),
    "/missing": (req, res) => res.writeHead(404, { "Content-Type": "text/plain" }).end("not found"),
    "/redirect": (req, res) => res.writeHead(302, { Location: "/text" }).end(),
    "/redirect-absolute": (req, res) => res.writeHead(301, { Location: "https://other.example/json" }).end(),
    "/redirect-blocked": (req, res) => res.writeHead(302, { Location: "https://box.tail1234.ts.net/" }).end(),
    "/redirect-ip": (req, res) => res.writeHead(302, { Location: "https://169.254.169.254/latest/meta-data/" }).end(),
    "/redirect-http": (req, res) => res.writeHead(302, { Location: "http://docs.example/text" }).end(),
    "/loop": (req, res) => res.writeHead(302, { Location: "/loop" }).end(),
    "/slow": () => {},
  };
  const requests = [];

  before(async () => {
    server = http.createServer((req, res) => {
      requests.push(`${req.headers.host} ${req.url}`);
      (routes[req.url] || routes["/missing"])(req, res);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = server.address().port;
  });

  after(() => server.close());

  // Every hostname resolves to the local test server; the transport speaks plain HTTP to it.
  function createTool(options = {}) {
    const log = [];
    const tool = createFetchTool({
      ...ANY,
      blockedHosts: ["ts.net"],
      onRequest: (message) => log.push(message),
      transport: { get: http.get, lookup: (hostname, opts, callback) => callback(null, [{ address: "127.0.0.1", family: 4 }]), port },
      isAllowedAddress: () => true,
      ...options,
    });
    return { run: (args) => tool.run(args), log, tool };
  }

  it("describes the tool", () => {
    const { tool } = createTool();
    assert.equal(tool.name, "fetch_url");
    assert.deepEqual(tool.parameters.required, ["url"]);
    assert.match(tool.description, /any public host/);
    assert.match(tool.description, /Blocked domains \(including subdomains\): ts.net/);
    assert.match(createTool({ allowedHosts: ["docs.rs", "crates.io"], blockedHosts: [] }).tool.description, /these hosts: docs.rs, crates.io/);
    assert.throws(() => createFetchTool({ allowedHosts: [] }), /must not be empty/);
  });

  it("fetches text without credentials and logs the request", async () => {
    const { run, log } = createTool();
    const result = await run({ url: "https://docs.example/text" });
    assert.equal(result, "URL: https://docs.example/text\nStatus: 200\nContent-Type: text/plain; charset=utf-8\n\nhello safe-research-ai-review (+https://github.com/safe-research/actions) no-auth");
    assert.deepEqual(log, ["GET https://docs.example/text -> 200"]);
    assert.equal(requests.at(-1), `docs.example:${port} /text`);
  });

  it("always returns the body as text", async () => {
    const { run } = createTool();
    assert.match(await run({ url: "https://registry.example/json" }), /\n\n\{"version":"1.2.3"\}$/);
    assert.match(await run({ url: "https://docs.example/latin1" }), /\n\ncafé$/);
    assert.match(await run({ url: "https://docs.example/binary" }), /Content-Type: application\/octet-stream\n\nabc$/);
  });

  it("converts HTML to text unless raw is requested", async () => {
    const { run } = createTool();
    assert.match(await run({ url: "https://docs.example/html" }), /\n\nTitle\n\nBody$/);
    assert.match(await run({ url: "https://docs.example/html", raw: true }), /\n\n<html><body><h1>Title<\/h1>/);
  });

  it("follows redirects and checks every hop", async () => {
    const { run, log } = createTool();
    assert.match(await run({ url: "https://docs.example/redirect" }), /^URL: https:\/\/docs.example\/text\nStatus: 200/);
    assert.match(await run({ url: "https://docs.example/redirect-absolute" }), /^URL: https:\/\/other.example\/json\n/);
    assert.deepEqual(log.slice(0, 2), ["GET https://docs.example/redirect -> 302", "GET https://docs.example/text -> 200"]);
    await assert.rejects(run({ url: "https://docs.example/redirect-blocked" }), /host is blocked: box.tail1234.ts.net/);
    await assert.rejects(run({ url: "https://docs.example/redirect-ip" }), /IP addresses are not allowed/);
    await assert.rejects(run({ url: "https://docs.example/redirect-http" }), /only https/);
    await assert.rejects(run({ url: "https://docs.example/loop" }), /too many redirects/);
  });

  it("applies the allowlist to redirects", async () => {
    const { run } = createTool({ allowedHosts: ["docs.example"] });
    await assert.rejects(run({ url: "https://docs.example/redirect-absolute" }), /not in the allowlist: other.example/);
  });

  it("rejects disallowed URLs before sending a request", async () => {
    const { run } = createTool();
    const count = requests.length;
    await assert.rejects(run({ url: "https://box.tail1234.ts.net/" }), /host is blocked/);
    await assert.rejects(run({ url: "https://127.0.0.1/" }), /IP addresses are not allowed/);
    await assert.rejects(run({ url: 42 }), /url must be a string/);
    assert.equal(requests.length, count);
  });

  it("refuses to connect to hosts that resolve to non-public addresses", async () => {
    const { run, log } = createTool({ isAllowedAddress: undefined });
    const count = requests.length;
    await assert.rejects(run({ url: "https://rebind.example/text" }), /rebind.example resolves to a non-public address \(127.0.0.1\)/);
    assert.equal(requests.length, count);
    assert.match(log[0], /failed/);
  });

  it("reports HTTP errors with the response", async () => {
    const { run } = createTool();
    await assert.rejects(run({ url: "https://docs.example/missing" }), /^Error: HTTP 404\nURL: https:\/\/docs.example\/missing\n[\s\S]*not found$/);
  });

  it("caps the downloaded and returned size", async () => {
    const { run } = createTool({ maxResponseBytes: 1000 });
    const result = await run({ url: "https://docs.example/big" });
    assert.match(result, /Note: only the first 1000 bytes of the response were read\n\nx{1000}$/);
    const capped = await createTool({ maxOutputBytes: 300 }).run({ url: "https://docs.example/big" });
    assert.match(capped, /\[output truncated: exceeded 300 bytes\]$/);
  });

  it("offers question only with an extractor", () => {
    assert.equal(createTool().tool.parameters.properties.question, undefined);
    const { tool } = createTool({ extract: async () => "" });
    assert.match(tool.parameters.properties.question.description, /larger than 8192 bytes \(and raw isn.t set\), only the lines that answer it are returned/);
    assert.match(tool.description, /Pass a question for documentation pages/);
  });

  it("extracts large responses when asked a question", async () => {
    const calls = [];
    const extract = async (input) => (calls.push(input), "Extract: lines 1-2");
    const { run } = createTool({ extract, extractThresholdBytes: 5000 });
    assert.equal(await run({ url: "https://docs.example/big", question: " what is x? " }), "URL: https://docs.example/big\nStatus: 200\nContent-Type: text/plain\n\nExtract: lines 1-2");
    assert.deepEqual(calls, [{ text: "x".repeat(10_000), contentType: "text/plain", question: "what is x?", url: "https://docs.example/big" }]);
    // Small responses and requests without a question are returned as they are.
    assert.match(await run({ url: "https://docs.example/text", question: "q" }), /\n\nhello /);
    assert.match(await run({ url: "https://docs.example/big", question: " " }), /\n\nx{10000}$/);
    assert.match(await run({ url: "https://docs.example/big" }), /\n\nx{10000}$/);
    assert.equal(calls.length, 1);
    // Raw HTML isn't extracted.
    const { run: runHtml } = createTool({ extract, extractThresholdBytes: 10 });
    assert.match(await runHtml({ url: "https://docs.example/html", question: "q", raw: true }), /\n\n<html>/);
    assert.equal(calls.length, 1);
    await assert.rejects(run({ url: "https://docs.example/big", question: 42 }), /question must be a string/);
  });

  it("returns the text from the start if the extraction fails", async () => {
    const { run } = createTool({ extract: async () => undefined, extractThresholdBytes: 5000, maxOutputBytes: 300 });
    assert.match(await run({ url: "https://docs.example/big", question: "q" }), /^URL: https:\/\/docs.example\/big\n[\s\S]*\nx+\n\[output truncated: exceeded 300 bytes\]$/);
  });

  it("caches successful responses for the run", async () => {
    const { run, log } = createTool();
    const count = requests.length;
    const first = await run({ url: "https://docs.example/redirect" });
    assert.equal(await run({ url: "https://docs.example/redirect" }), first);
    assert.equal(requests.length, count + 2);
    assert.deepEqual(log, ["GET https://docs.example/redirect -> 302", "GET https://docs.example/text -> 200", "GET https://docs.example/redirect -> cached"]);
    await assert.rejects(run({ url: "https://docs.example/missing" }), /HTTP 404/);
    await assert.rejects(run({ url: "https://docs.example/missing" }), /HTTP 404/);
    assert.equal(requests.length, count + 4);
  });

  it("times out", async () => {
    const { run } = createTool({ timeoutMs: 100 });
    await assert.rejects(run({ url: "https://docs.example/slow" }), /timed out after 100 ms/);
  });
});
