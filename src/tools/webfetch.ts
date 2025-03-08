import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { z } from "zod";
import type { Tool } from "./tool";

const inputSchema = z.object({ url: z.string().url() });
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 200_000;
const MAX_REDIRECTS = 3;

function ipv4Number(address: string): number {
  return address.split(".").reduce((value, octet) => (value * 256 + Number(octet)) >>> 0, 0);
}

function inIpv4Range(address: number, prefix: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (address & mask) === (ipv4Number(prefix) & mask);
}

function isPublicIpv4(address: string): boolean {
  const value = ipv4Number(address);
  const blocked: [string, number][] = [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.88.99.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ];
  return !blocked.some(([prefix, bits]) => inIpv4Range(value, prefix, bits));
}

function ipv6Number(address: string): bigint {
  if (address.includes("%")) throw new Error("Scoped IPv6 addresses are not allowed.");
  let normalized = address.toLowerCase();
  const ipv4Start = normalized.lastIndexOf(":");
  if (normalized.includes(".")) {
    const tail = normalized.slice(ipv4Start + 1).split(".").map(Number);
    if (tail.length !== 4 || tail.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
      throw new Error("Invalid IPv6 address.");
    }
    const high = ((tail[0] << 8) | tail[1]).toString(16);
    const low = ((tail[2] << 8) | tail[3]).toString(16);
    normalized = `${normalized.slice(0, ipv4Start)}:${high}:${low}`;
  }
  const halves = normalized.split("::");
  if (halves.length > 2) throw new Error("Invalid IPv6 address.");
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const zeroCount = halves.length === 2 ? 8 - left.length - right.length : 0;
  const parts = halves.length === 2 ? [...left, ...Array(zeroCount).fill("0"), ...right] : left;
  if (parts.length !== 8 || parts.some((part) => !/^[\da-f]{1,4}$/.test(part))) {
    throw new Error("Invalid IPv6 address.");
  }
  return parts.reduce((value, part) => (value << 16n) | BigInt(`0x${part}`), 0n);
}

function isPublicIpv6(address: string): boolean {
  const value = ipv6Number(address);
  const hasPrefix = (prefix: string, bits: number) =>
    value >> BigInt(128 - bits) === ipv6Number(prefix) >> BigInt(128 - bits);
  // Only global unicast space is allowed; exclude special-purpose and tunnel ranges.
  return (
    value >> 125n === 1n &&
    !hasPrefix("2001:db8::", 32) &&
    !hasPrefix("2001::", 23) &&
    !hasPrefix("2002::", 16)
  );
}

function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4 ? isPublicIpv4(address) : family === 6 ? isPublicIpv6(address) : false;
}

async function resolvePublicDestination(url: URL): Promise<{ address: string; family: number }> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only HTTP and HTTPS URLs are supported.");
  }
  if (url.username || url.password) throw new Error("URLs with embedded credentials are not allowed.");
  if (url.port && url.port !== "80" && url.port !== "443") {
    throw new Error("Only the default HTTP and HTTPS ports are allowed.");
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".internal")) {
    throw new Error("Local and internal hosts are not allowed.");
  }
  if (isIP(hostname)) {
    if (!isPublicAddress(hostname)) throw new Error("Private or reserved network addresses are not allowed.");
    return { address: hostname, family: isIP(hostname) };
  }

  const records = await lookup(hostname, { all: true, verbatim: true });
  if (!records.length || records.some(({ address }) => !isPublicAddress(address))) {
    throw new Error("The host resolves to a private or reserved network address.");
  }
  return records[0];
}

async function fetchPublicUrl(initialUrl: URL, signal: AbortSignal): Promise<Response> {
  let url = initialUrl;
  for (let redirects = 0; ; redirects++) {
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const destination = await resolvePublicDestination(url);
    const dialUrl = new URL(url.href);
    dialUrl.hostname = destination.family === 6 ? `[${destination.address}]` : destination.address;
    const headers = new Headers({ "User-Agent": "CodingAgent/1.0" });
    const request: RequestInit & { proxy: false; tls?: { serverName: string } } = {
      headers,
      redirect: "manual",
      signal,
      proxy: false,
    };
    if (!isIP(hostname)) {
      headers.set("Host", url.host);
      if (url.protocol === "https:") request.tls = { serverName: hostname };
    }
    const response = await fetch(dialUrl, request);
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    if (redirects >= MAX_REDIRECTS) {
      await response.body?.cancel();
      throw new Error(`Too many redirects (limit: ${MAX_REDIRECTS}).`);
    }
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location) throw new Error("Redirect response did not include a location.");
    url = new URL(location, url);
  }
}

async function readResponseText(response: Response): Promise<{ text: string; bytes: number }> {
  if (!response.body) return { text: "", bytes: 0 };

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      bytesRead += value.byteLength;
      if (bytesRead > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error(`Response is larger than ${MAX_RESPONSE_BYTES} bytes.`);
      }
      text += decoder.decode(value, { stream: true });
    }
    return { text: text + decoder.decode(), bytes: bytesRead };
  } finally {
    reader.releaseLock();
  }
}

export const webFetchTool: Tool = {
  definition: {
    name: "webfetch",
    description: "Fetch an HTTP or HTTPS URL and return its text content. Does not execute JavaScript.",
    parameters: {
      type: "object",
      properties: { url: { type: "string", description: "An HTTP or HTTPS URL." } },
      required: ["url"],
    },
  },
  async execute(input) {
    const { url } = inputSchema.parse(input);
    const parsedUrl = new URL(url);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetchPublicUrl(parsedUrl, controller.signal);
      if (!response.ok) throw new Error(`Request failed with HTTP ${response.status}.`);

      const content = await readResponseText(response);
      return [
        `url: ${response.url}`,
        `status: ${response.status}`,
        `content-type: ${response.headers.get("content-type") ?? "unknown"}`,
        `bytes: ${content.bytes} (limit: ${MAX_RESPONSE_BYTES})`,
        "",
        content.text || "(empty response)",
      ].join("\n");
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`Request timed out after ${REQUEST_TIMEOUT_MS / 1000} seconds.`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  },
};
