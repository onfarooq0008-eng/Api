'use strict';
const net = require('node:net');
const dns = require('node:dns');
const { ApiError } = require('./errors');

/**
 * SSRF guard for the file proxy. Two layers:
 *  1. assertPublicTarget(): rejects internal hostnames and IP literals up front
 *     (IP literals never trigger a DNS lookup, so only this layer can see them).
 *  2. guardedLookup: passed to http(s).request as `lookup`, so the address that
 *     is actually connected to is the one that is checked (defeats DNS rebinding).
 * Both run again on every redirect hop.
 */

const blocked = new net.BlockList();
[
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3], // multicast + reserved + broadcast
].forEach(([a, p]) => blocked.addSubnet(a, p, 'ipv4'));
[
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['2001:db8::', 32], ['64:ff9b::', 96],
].forEach(([a, p]) => blocked.addSubnet(a, p, 'ipv6'));

const BAD_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa', '.lan'];

/** Extract the embedded IPv4 from IPv4-mapped / compatible IPv6 forms, or null. */
function embeddedV4(ip) {
  const s = ip.toLowerCase();
  let m = s.match(/^(?:0{0,4}:){2,5}(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/);
  if (m) return m[1];
  m = s.match(/^(?:0{0,4}:){2,5}ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (m) {
    const hi = parseInt(m[1], 16), lo = parseInt(m[2], 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return null;
}

function isPrivateAddress(ip) {
  const kind = net.isIP(ip);
  if (!kind) return true; // not an IP -> refuse
  if (kind === 6) {
    const v4 = embeddedV4(ip.split('%')[0]);
    if (v4) return isPrivateAddress(v4);
    return blocked.check(ip.split('%')[0], 'ipv6');
  }
  return blocked.check(ip, 'ipv4');
}

/** Throws ApiError(400) unless the URL is an http(s) URL pointing at a public host. */
function assertPublicTarget(u, { allowedHosts = [], allowPrivate = false } = {}) {
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new ApiError(400, 'BAD_URL', 'Only http(s) URLs are allowed.');
  if (u.username || u.password) throw new ApiError(400, 'BAD_URL', 'URLs with credentials are not allowed.');
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) throw new ApiError(400, 'BAD_URL', 'URL has no host.');

  if (allowedHosts.length && !allowedHosts.some((d) => host === d || host.endsWith('.' + d))) {
    throw new ApiError(400, 'HOST_NOT_ALLOWED', 'This host is not on the allowed list.');
  }
  if (allowPrivate) return;
  if (host === 'localhost' || BAD_SUFFIXES.some((s) => host.endsWith(s))) throw new ApiError(400, 'HOST_BLOCKED', 'Internal hosts are not allowed.');
  if (net.isIP(host) && isPrivateAddress(host)) throw new ApiError(400, 'HOST_BLOCKED', 'Private or reserved addresses are not allowed.');
}

/** dns.lookup replacement that refuses private results. */
function createGuardedLookup({ allowPrivate = false } = {}) {
  return (hostname, options, cb) => {
    if (typeof options === 'function') { cb = options; options = {}; }
    dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
      if (err) return cb(err);
      if (!allowPrivate && addrs.some((a) => isPrivateAddress(a.address))) {
        return cb(new ApiError(400, 'HOST_BLOCKED', 'Host resolves to a private or reserved address.'));
      }
      if (options && options.all) return cb(null, addrs);
      cb(null, addrs[0].address, addrs[0].family);
    });
  };
}

module.exports = { isPrivateAddress, assertPublicTarget, createGuardedLookup };
