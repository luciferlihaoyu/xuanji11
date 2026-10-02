/**
 * safeFetch：把「出网校验」与「实际连接」合并成一次原子的动作。
 *
 * 背景（PLAN-出口校验TOCTOU §1.1/§1.2）：assertEgressAllowed 校验完只返回 void，
 * 调用方随后的 fetch 会**再次解析 DNS**——两次解析之间答案可以被换掉（DNS rebinding），
 * 且 assertEgressAllowed 的 60s passCache 会把概率竞态放大成确定性窗口。
 *
 * safeFetch 的做法：解析一次 → 逐地址判定 → 连接时通过 net.connect 的 lookup 钩子
 * **只允许去判定通过的那个地址**。URL 保留原 hostname，因此 TLS SNI / 证书校验 /
 * Host 头全部天然正确。解析与连接同源 ⇒ TOCTOU 在结构上不可能发生。
 *
 * - redirect:'manual'：3xx 原样交回调用方逐跳处理（RSS 连接器的既有语义）；
 *   redirect:'follow'（默认）：自动跟随，但**每一跳都重新解析并判定**。
 * - 零新增依赖：基于 node:http / node:https。
 */
import * as http from "node:http";
import * as https from "node:https";
import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { EgressError, isBlockedAddress, isPrivateNetAllowed, resolveHostForEgress, type EgressScope } from "./egress";

/** safeFetch 的最小响应面（调用方现有用法：status/statusText/ok/headers.get/body 流/text()/arrayBuffer()）。 */
export interface SafeFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  readonly headers: { get(name: string): string | null };
  readonly body: ReadableStream<Uint8Array> | null;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface SafeFetchInit {
  method?: string;
  headers?: Record<string, string>;
  /** 'manual'：3xx 不跟随，交回调用方；'follow'（默认）：自动跟随并逐跳重新校验，上限 5 跳 */
  redirect?: "manual" | "follow";
  signal?: AbortSignal;
  /** 出网口径：**默认 "user"**（用户/上游可控 URL，恒不进内网，任何配置都开不了）；
   *  管理员亲手配置的固定服务目标（网盘签名地址、LLM 端点等）显式传 "admin"。 */
  scope?: EgressScope;
}

/** 测试运输口：注入后 safeFetch 直接透传（不打真网络、也不做校验），供既有单测桩复用。 */
type Transport = (url: string, init?: SafeFetchInit) => Promise<SafeFetchResponse>;
let transportForTests: Transport | null = null;

export function setSafeFetchTransportForTests(transport: Transport | null): void {
  transportForTests = transport;
}

const MAX_REDIRECTS = 5;

interface PinnedAddress {
  address: string;
  family: 4 | 6;
}

export async function safeFetch(rawUrl: string, init: SafeFetchInit = {}): Promise<SafeFetchResponse> {
  if (transportForTests) return transportForTests(rawUrl, init);

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new EgressError("egress blocked: invalid url");
  }

  const redirect = init.redirect ?? "follow";
  let current = url;
  for (let hop = 0; ; hop++) {
    if (current.protocol !== "http:" && current.protocol !== "https:") {
      throw new EgressError(`egress blocked: unsupported protocol ${current.protocol}`);
    }
    // 策略**每跳重读**：与 RSS 连接器"每一跳重新过闸"的既有口径一致（策略可能中途改变，缓存不算数）。
    // scope 默认 "user"：用户/上游可控 URL 恒不进内网；管理员配置目标显式传 "admin"。
    const allowPrivate = await isPrivateNetAllowed(init.scope ?? "user");
    // ① 解析一次、逐地址判定；② 连接只允许去 pinned 那个地址
    const pinned = await resolveAndValidate(current.hostname, allowPrivate);
    const res = await requestOnce(current, init, pinned);
    const status = res.statusCode ?? 0;
    if (redirect === "follow" && status >= 300 && status < 400 && hop < MAX_REDIRECTS) {
      const location = headerOf(res, "location");
      if (location) {
        res.resume(); // 丢弃 3xx 响应体，连接干净地结束
        let next: URL;
        try {
          next = new URL(location, current); // 相对路径按当前地址解析为绝对 URL
        } catch {
          throw new EgressError("egress blocked: invalid redirect location");
        }
        current = next;
        continue; // 每一跳回到顶部重新解析、重新判定、重新钉
      }
    }
    return toResponse(res);
  }
}

/** 解析 + 判定 + 选定要钉的地址（IP 字面量不查 DNS，与 egress.ts 同口径）。 */
async function resolveAndValidate(hostnameRaw: string, allowPrivate: boolean): Promise<PinnedAddress> {
  const host = hostnameRaw.replace(/^\[|\]$/g, "");
  let addresses: string[];
  if (isIpLiteral(host)) {
    addresses = [host];
  } else {
    addresses = await resolveHostForEgress(host).catch(() => {
      throw new EgressError("egress blocked: cannot resolve host");
    });
  }
  if (addresses.length === 0) {
    throw new EgressError("egress blocked: cannot resolve host");
  }
  if (!allowPrivate) {
    for (const addr of addresses) {
      if (isBlockedAddress(addr)) {
        throw new EgressError("egress blocked: private or blocked address");
      }
    }
  }
  const chosen = addresses[0];
  return { address: chosen, family: chosen.includes(":") ? 6 : 4 };
}

function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || (/^[0-9a-f:.]+$/i.test(host) && host.includes(":"));
}

function requestOnce(url: URL, init: SafeFetchInit, pinned: PinnedAddress): Promise<IncomingMessage> {
  return new Promise<IncomingMessage>((resolve, reject) => {
    const mod = url.protocol === "https:" ? https : http;
    const lookup = (
      _hostname: string,
      opts: unknown,
      cb: (err: Error | null, address?: string, family?: number) => void,
    ) => {
      // ★ 钉住：不管系统 DNS 这次怎么说，连接只允许去「刚才判定通过」的那个地址。
      // Node ≥20 autoSelectFamily 路径会带 all:true 调 lookup、要求数组形态；经典路径要 (ip, family)。
      // 两种契约都答对，且只给一个地址 —— happy-eyeballs 也没有第二个候选可试。
      const o = opts as { all?: boolean } | undefined;
      if (o?.all) {
        (cb as unknown as (err: Error | null, addresses?: Array<{ address: string; family: number }>) => void)(
          null,
          [{ address: pinned.address, family: pinned.family }],
        );
      } else {
        cb(null, pinned.address, pinned.family);
      }
    };
    const options: https.RequestOptions = {
      method: init.method ?? "GET",
      headers: init.headers,
      signal: init.signal,
      agent: false, // 每次全新连接，钉住语义最干净
    };
    (options as { lookup?: unknown }).lookup = lookup;
    let settled = false;
    const req = mod.request(url, options, (res) => {
      settled = true;
      resolve(res);
    });
    req.on("error", (err) => {
      if (!settled) reject(err);
    });
    req.end();
  });
}

function headerOf(res: IncomingMessage, name: string): string | null {
  const value = res.headers[name.toLowerCase()];
  return Array.isArray(value) ? value.join(", ") : (value ?? null);
}

function toResponse(res: IncomingMessage): SafeFetchResponse {
  const status = res.statusCode ?? 0;
  const nodeStream = res as unknown as Readable;
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: res.statusMessage ?? "",
    headers: {
      get(name: string): string | null {
        return headerOf(res, name);
      },
    },
    body: Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>,
    text: async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of nodeStream) chunks.push(chunk as Buffer);
      return Buffer.concat(chunks).toString("utf-8");
    },
    arrayBuffer: async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of nodeStream) chunks.push(chunk as Buffer);
      const buf = Buffer.concat(chunks);
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    },
  };
}
