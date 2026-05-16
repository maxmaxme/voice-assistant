export interface SingBoxConfig {
  log: { level: string };
  inbounds: Array<{
    type: 'socks';
    tag: string;
    listen: string;
    listen_port: number;
  }>;
  outbounds: Array<{
    type: 'vless';
    tag: string;
    server: string;
    server_port: number;
    uuid: string;
    flow: string;
    tls: {
      enabled: true;
      server_name: string;
      utls: { enabled: true; fingerprint: string };
      reality: { enabled: true; public_key: string; short_id: string };
    };
  }>;
}

function require_(value: string | null, name: string): string {
  if (!value) {
    throw new Error(`Missing required URL parameter: ${name}`);
  }
  return value;
}

export function parseVlessUrl(input: string): SingBoxConfig {
  if (!input.startsWith('vless://')) {
    throw new Error(`Unsupported scheme: ${input.slice(0, 16)}... (only vless:// is supported)`);
  }

  const u = new URL(input);
  const q = u.searchParams;

  return {
    log: { level: 'info' },
    inbounds: [{ type: 'socks', tag: 'in', listen: '0.0.0.0', listen_port: 1080 }],
    outbounds: [
      {
        type: 'vless',
        tag: 'out',
        server: u.hostname,
        server_port: Number(u.port || '443'),
        uuid: decodeURIComponent(u.username),
        flow: require_(q.get('flow'), 'flow'),
        tls: {
          enabled: true,
          server_name: require_(q.get('sni'), 'sni'),
          utls: { enabled: true, fingerprint: q.get('fp') ?? 'chrome' },
          reality: {
            enabled: true,
            public_key: require_(q.get('pbk'), 'pbk'),
            short_id: require_(q.get('sid'), 'sid'),
          },
        },
      },
    ],
  };
}
