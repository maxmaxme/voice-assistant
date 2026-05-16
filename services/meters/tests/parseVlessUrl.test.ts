import { describe, it, expect } from 'vitest';
import { parseVlessUrl } from '../src/proxy/parseVlessUrl.ts';

const sample =
  'vless://uuid-aaaa-bbbb-cccc@example.com:443?security=reality&type=tcp&flow=xtls-rprx-vision&sni=cloudflare.com&fp=chrome&pbk=PUBKEY123&sid=SHORTID456#%F0%9F%87%B7%F0%9F%87%BA%20RU';

describe('parseVlessUrl', () => {
  it('parses a VLESS+Reality URL into a sing-box config object', () => {
    const cfg = parseVlessUrl(sample);

    expect(cfg.inbounds).toEqual([
      { type: 'socks', tag: 'in', listen: '0.0.0.0', listen_port: 1080 },
    ]);

    expect(cfg.outbounds).toHaveLength(1);
    const out = cfg.outbounds[0];
    expect(out).toMatchObject({
      type: 'vless',
      tag: 'out',
      server: 'example.com',
      server_port: 443,
      uuid: 'uuid-aaaa-bbbb-cccc',
      flow: 'xtls-rprx-vision',
    });
    expect(out.tls).toMatchObject({
      enabled: true,
      server_name: 'cloudflare.com',
      utls: { enabled: true, fingerprint: 'chrome' },
      reality: {
        enabled: true,
        public_key: 'PUBKEY123',
        short_id: 'SHORTID456',
      },
    });
  });

  it('throws on a non-VLESS scheme', () => {
    expect(() => parseVlessUrl('trojan://pw@x.example:443')).toThrow(/scheme/i);
    expect(() => parseVlessUrl('ss://abc@x.example:443')).toThrow(/scheme/i);
  });

  it('throws when required parameters are missing', () => {
    expect(() =>
      parseVlessUrl('vless://uuid@example.com:443?security=reality&type=tcp&flow=xtls-rprx-vision'),
    ).toThrow(/pbk|sid|sni/);
  });
});
