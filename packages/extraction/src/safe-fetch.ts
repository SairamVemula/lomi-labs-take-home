import { lookup as dnsLookup } from "node:dns";
import { BlockList, isIP } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";

const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["192.0.0.0", 24],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blocked.addSubnet(net, prefix, "ipv4");
}
blocked.addAddress("::", "ipv6");
blocked.addAddress("::1", "ipv6");
blocked.addSubnet("fc00::", 7, "ipv6");
blocked.addSubnet("fe80::", 10, "ipv6");

function mappedV4(ip: string): string | null {
  const m = /^::ffff:(.+)$/i.exec(ip);
  if (!m) return null;
  const rest = m[1]!;
  if (isIP(rest) === 4) return rest;
  const h = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(rest);
  if (!h) return null;
  const hi = parseInt(h[1]!, 16);
  const lo = parseInt(h[2]!, 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

export function isBlockedAddress(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, "").split("%")[0]!;
  const kind = isIP(bare);
  if (kind === 0) return true; // unparseable: fail closed
  if (kind === 4) return blocked.check(bare, "ipv4");
  const v4 = mappedV4(bare);
  if (v4) return blocked.check(v4, "ipv4");
  return blocked.check(bare, "ipv6");
}

type LookupCb = (err: Error | null, addresses: unknown, family?: number) => void;

export function createSafeFetch(opts: { allowPrivateHosts: boolean }): typeof fetch {
  const agent = opts.allowPrivateHosts
    ? new Agent()
    : new Agent({
        connect: {
          lookup: (hostname: string, options: { all?: boolean }, cb: LookupCb) => {
            dnsLookup(hostname, { all: true }, (err, addrs) => {
              if (err) return cb(err, []);
              const list = addrs as { address: string; family: number }[];
              if (list.length === 0 || list.some((a) => isBlockedAddress(a.address))) {
                return cb(new Error(`blocked address for host ${hostname}`), []);
              }
              if (options.all) return cb(null, list);
              return cb(null, list[0]!.address, list[0]!.family);
            });
          },
        } as never,
      });

  const safe = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw);
    if (!opts.allowPrivateHosts) {
      if (url.protocol !== "https:") throw new Error("https required");
      const host = url.hostname.replace(/^\[|\]$/g, "");
      if (isIP(host) !== 0 && isBlockedAddress(host)) throw new Error(`blocked address ${host}`);
    }
    const res = await undiciFetch(input as never, { ...(init as object), dispatcher: agent, redirect: "error" });
    return res as unknown as Response;
  };
  return safe as typeof fetch;
}
