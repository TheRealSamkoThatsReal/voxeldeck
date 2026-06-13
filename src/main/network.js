'use strict';

const os = require('os');

/**
 * Network helpers for the "Connect" tab: the machine's local (LAN) IPv4, a
 * best-guess router gateway, and the public (internet) IP via a lookup service.
 */

/** All non-internal IPv4 addresses, best LAN candidate first. */
function localIPv4s() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push({ iface: name, address: ni.address });
    }
  }
  // Prefer the common home-network ranges (192.168/10/172.16-31).
  const score = (a) =>
    a.address.startsWith('192.168.') ? 0
      : a.address.startsWith('10.') ? 1
        : /^172\.(1[6-9]|2\d|3[01])\./.test(a.address) ? 2 : 3;
  out.sort((x, y) => score(x) - score(y));
  return out;
}

function primaryLocalIPv4() {
  const all = localIPv4s();
  return all.length ? all[0].address : null;
}

/** Best guess at the router's admin address (the LAN IP with .1 at the end). */
function likelyGateway(ip) {
  if (!ip) return null;
  const m = ip.match(/^(\d+\.\d+\.\d+)\.\d+$/);
  return m ? `${m[1]}.1` : null;
}

/** Look up the public/internet IP from a few fallback services. */
async function publicIP() {
  const services = ['https://api.ipify.org', 'https://icanhazip.com', 'https://ifconfig.me/ip'];
  let lastErr;
  for (const url of services) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'VoxelDeck' }, signal: AbortSignal.timeout(6000) });
      if (!res.ok) { lastErr = new Error(`HTTP ${res.status}`); continue; }
      const ip = (await res.text()).trim();
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip) || ip.includes(':')) return ip; // IPv4 or IPv6
      lastErr = new Error('Unexpected response');
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`Couldn't look up your public address — are you online? (${lastErr ? lastErr.message : 'unknown'})`);
}

module.exports = { localIPv4s, primaryLocalIPv4, likelyGateway, publicIP };
