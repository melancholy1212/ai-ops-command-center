// The egress policy test matrix (docs/mcp.md#testing): address ranges, URL policy, and the fetcher against a
// real local HTTP server. The server listens on loopback, which the policy blocks; tests widen the address
// and port policy to exactly that server, and assert the defaults separately.
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isBlockedAddress } from './egress/address';
import { createSafeFetcher, FetchError, type SafeFetcherOptions } from './egress/fetcher';
import { checkUrl } from './egress/policy';
import { createRobotsCache } from './egress/robots';
import { normalizeUrl } from './egress/url';

describe('address blocklist', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '240.0.0.1',
    '255.255.255.255',
    '192.0.2.1',
    '198.51.100.7',
    '203.0.113.9',
    '198.18.0.1',
    '::1',
    '::',
    'fc00::1',
    'fd00:ec2::254',
    'fe80::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:169.254.169.254',
    '64:ff9b::a9fe:a9fe',
    '2002:7f00:1::1',
    '2001:db8::1',
    '2001::1',
    'not-an-ip',
  ])('blocks %s', (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8', '64:ff9b::808:808'])(
    'allows %s',
    (address) => {
      expect(isBlockedAddress(address)).toBe(false);
    },
  );
});

describe('URL normalisation', () => {
  it('drops fragments, tracking parameters and default ports, keeping other parameters in order', () => {
    expect(normalizeUrl('HTTPS://News.Example:443/a/b?b=2&utm_source=x&a=1&gclid=z#frag')).toBe(
      'https://news.example/a/b?b=2&a=1',
    );
    expect(normalizeUrl('http://example.com:80')).toBe('http://example.com/');
  });

  it('keeps ß distinct from ss (non-transitional IDNA)', () => {
    expect(normalizeUrl('https://straße.de/')).toBe('https://xn--strae-oqa.de/');
    expect(normalizeUrl('https://strasse.de/')).toBe('https://strasse.de/');
  });

  it('refuses anything but http and https', () => {
    expect(normalizeUrl('file:///etc/passwd')).toBeNull();
    expect(normalizeUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeUrl('not a url')).toBeNull();
  });
});

describe('URL policy', () => {
  it.each([
    ['file:///etc/passwd', 'only http and https'],
    ['ftp://example.com/', 'only http and https'],
    ['http://example.com:8080/', 'only ports 80 and 443'],
    ['https://user:pass@example.com/', 'credentials in the URL'],
    ['http://169.254.169.254/latest/meta-data/', 'address not publicly routable'],
    ['http://[::1]/', 'address not publicly routable'],
    ['http://2130706433/', 'address not publicly routable'],
    ['http://0x7f.1/', 'address not publicly routable'],
    ['http://localhost/', 'not a public host name'],
    ['https://www.linkedin.com/in/someone', 'domain is on the denylist'],
  ])('refuses %s (%s)', (url, reason) => {
    expect(checkUrl(url)).toEqual({ ok: false, reason });
  });

  it('applies an extra denylist and allows ordinary public URLs', () => {
    expect(checkUrl('https://blog.example.org/x', { denylist: ['example.org'] })).toMatchObject({ ok: false });
    expect(checkUrl('https://www.example.com/about')).toMatchObject({ ok: true });
  });
});

describe('safe fetcher', () => {
  let server: Server;
  let port: number;
  const routes = new Map<string, (res: ServerResponse) => void>();
  const html = (body: string) => (res: ServerResponse) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<html><body>${body}</body></html>`);
  };

  beforeAll(async () => {
    server = createServer((req, res) => {
      const route = routes.get(req.url ?? '');
      if (route) route(res);
      else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  /** Public-looking names resolve to the local server; only loopback is exempted from the blocklist. */
  const fetcher = (overrides: Partial<SafeFetcherOptions> = {}) =>
    createSafeFetcher({
      allowedPorts: [String(port)],
      isBlocked: (ip) => ip !== '127.0.0.1' && isBlockedAddress(ip),
      resolve: (host) =>
        Promise.resolve(
          host === 'rebind.example'
            ? [
                { address: '127.0.0.1', family: 4 },
                { address: '10.0.0.5', family: 4 },
              ]
            : host === 'private.example'
              ? [{ address: '10.0.0.5', family: 4 }]
              : [{ address: '127.0.0.1', family: 4 }],
        ),
      ...overrides,
    });
  const url = (path: string, host = 'site.example') => `http://${host}:${String(port)}${path}`;
  const failure = async (promise: Promise<unknown>) => {
    const error = await promise.then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(FetchError);
    return error as FetchError;
  };
  const signal = () => AbortSignal.timeout(10_000);

  it('connects to the address it validated and records it', async () => {
    routes.set('/ok', html('<p>Hello</p>'));
    const page = await fetcher().fetch(url('/ok'), signal());
    expect(page).toMatchObject({ status: 200, contentType: 'text/html', resolvedIp: '127.0.0.1', redirectChain: [] });
    expect(page.body.toString()).toContain('Hello');
  });

  it('refuses a name that resolves to a private address, even alongside a public one (rebinding)', async () => {
    routes.set('/ok', html('<p>Hello</p>'));
    expect((await failure(fetcher().fetch(url('/ok', 'private.example'), signal()))).code).toBe('URL_BLOCKED');
    expect((await failure(fetcher().fetch(url('/ok', 'rebind.example'), signal()))).code).toBe('URL_BLOCKED');
  });

  it('with the default policy refuses the local server outright', async () => {
    const strict = createSafeFetcher({ resolve: () => Promise.resolve([{ address: '127.0.0.1', family: 4 }]) });
    expect((await failure(strict.fetch('http://site.example/ok', signal()))).code).toBe('URL_BLOCKED');
  });

  it('re-validates every redirect hop and records the chain', async () => {
    routes.set('/hop1', (res) => res.writeHead(302, { location: url('/hop2', 'other.example') }).end());
    routes.set('/hop2', (res) => res.writeHead(301, { location: '/final' }).end());
    routes.set('/final', html('<p>Arrived</p>'));
    const page = await fetcher().fetch(url('/hop1'), signal());
    expect(page.finalUrl).toBe(url('/final', 'other.example'));
    expect(page.redirectChain).toEqual([url('/hop2', 'other.example'), url('/final', 'other.example')]);

    routes.set('/to-metadata', (res) =>
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }).end(),
    );
    expect((await failure(fetcher().fetch(url('/to-metadata'), signal()))).code).toBe('URL_BLOCKED');
    routes.set('/loop', (res) => res.writeHead(302, { location: '/loop' }).end());
    expect((await failure(fetcher().fetch(url('/loop'), signal()))).message).toMatch(/Too many redirects/);
  });

  it('refuses unsupported content types, oversized bodies and decompression bombs', async () => {
    routes.set('/pdf', (res) => res.writeHead(200, { 'content-type': 'application/pdf' }).end('%PDF'));
    expect((await failure(fetcher().fetch(url('/pdf'), signal()))).code).toBe('UNSUPPORTED_CONTENT_TYPE');

    routes.set('/declared-big', (res) =>
      res.writeHead(200, { 'content-type': 'text/html', 'content-length': '9999999' }).end(),
    );
    expect((await failure(fetcher().fetch(url('/declared-big'), signal()))).code).toBe('CONTENT_TOO_LARGE');

    routes.set('/streamed-big', (res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('x'.repeat(20_000));
    });
    const small = fetcher({ limits: { maxWireBytes: 10_000 } });
    expect((await failure(small.fetch(url('/streamed-big'), signal()))).code).toBe('CONTENT_TOO_LARGE');

    const bomb = gzipSync(Buffer.alloc(5_000_000, 0x61));
    routes.set('/bomb', (res) =>
      res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' }).end(bomb),
    );
    const bombLimited = fetcher({ limits: { maxDecodedBytes: 100_000 } });
    expect((await failure(bombLimited.fetch(url('/bomb'), signal()))).code).toBe('CONTENT_TOO_LARGE');
  });

  it('decompresses gzip bodies within the limits', async () => {
    routes.set('/gz', (res) =>
      res
        .writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' })
        .end(gzipSync('<p>Compressed</p>')),
    );
    expect((await fetcher().fetch(url('/gz'), signal())).body.toString()).toBe('<p>Compressed</p>');
  });

  it('gives up on slow servers and maps HTTP errors', async () => {
    routes.set('/slow', (res) => {
      setTimeout(() => {
        html('late')(res);
      }, 1_500);
    });
    const impatient = fetcher({ limits: { headersTimeoutMs: 300 } });
    const slow = await failure(impatient.fetch(url('/slow'), signal()));
    expect([slow.code, slow.retryable]).toEqual(['TIMEOUT', true]);
    expect((await failure(fetcher().fetch(url('/missing'), signal()))).code).toBe('NOT_FOUND');
    routes.set('/boom', (res) => res.writeHead(503).end());
    const boom = await failure(fetcher().fetch(url('/boom'), signal()));
    expect([boom.code, boom.retryable]).toEqual(['UPSTREAM_ERROR', true]);
  });

  it('honours robots.txt: rules on 2xx, allow on 404, disallow on 5xx', async () => {
    const policy = {
      allowedPorts: [String(port)],
      isBlocked: (ip: string) => ip !== '127.0.0.1' && isBlockedAddress(ip),
    };
    const resolve = () => Promise.resolve([{ address: '127.0.0.1', family: 4 }]);
    routes.set('/page', html('<p>Page</p>'));
    routes.set('/private/page', html('<p>Private</p>'));

    routes.set('/robots.txt', (res) =>
      res.writeHead(200, { 'content-type': 'text/plain' }).end('User-agent: *\nDisallow: /private/\n'),
    );
    const withRules = fetcher({ robots: createRobotsCache({ ...policy, resolve }) });
    expect((await withRules.fetch(url('/page'), signal())).status).toBe(200);
    expect((await failure(withRules.fetch(url('/private/page'), signal()))).code).toBe('ROBOTS_DISALLOWED');

    routes.delete('/robots.txt');
    const noRobots = fetcher({ robots: createRobotsCache({ ...policy, resolve }) });
    expect((await noRobots.fetch(url('/private/page', 'fresh.example'), signal())).status).toBe(200);

    routes.set('/robots.txt', (res) => res.writeHead(500).end());
    const brokenRobots = fetcher({ robots: createRobotsCache({ ...policy, resolve }) });
    expect((await failure(brokenRobots.fetch(url('/page', 'broken.example'), signal()))).code).toBe(
      'ROBOTS_DISALLOWED',
    );
  });

  it('asks the throttle before every hop', async () => {
    const hosts: string[] = [];
    routes.set('/r', (res) => res.writeHead(302, { location: url('/ok', 'next.example') }).end());
    routes.set('/ok', html('<p>ok</p>'));
    await fetcher({
      throttle: (host) => {
        hosts.push(host);
        return Promise.resolve();
      },
    }).fetch(url('/r'), signal());
    expect(hosts).toEqual(['site.example', 'next.example']);
  });
});
