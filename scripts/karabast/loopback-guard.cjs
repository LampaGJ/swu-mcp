/**
 * @displayName Loopback-only network guard
 * @strategicPurpose The offline karabast phases (#182) must never reach karabast.net or any other host: the local
 * gamenode and our client are both run with this preloaded (`node --require`), so a stray outbound call fails loudly
 * instead of leaving the machine.
 * @tacticalObjective Patches net.Socket.prototype.connect to throw for any TCP host other than loopback (127.0.0.0/8,
 * ::1, localhost; IPC paths pass), and net.Server.prototype.listen to bind a port-only listen to 127.0.0.1, because
 * the gamenode calls server.listen(port), which would otherwise accept connections on every interface. Covers http,
 * https, fetch (undici) and socket.io, which all connect through net.Socket.
 */
"use strict";
/* global require, module -- CommonJS, because node --require preloads only CommonJS */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const net = require("node:net");

const LOOPBACK = /^(127\.\d+\.\d+\.\d+|::1|localhost|::ffff:127\.\d+\.\d+\.\d+)$/i;

function hostOf(args) {
  const first = args[0];
  if (Array.isArray(first)) return hostOf(first);
  if (first !== null && typeof first === "object") {
    if (typeof first.path === "string") return null;
    return first.host === undefined ? "localhost" : String(first.host);
  }
  if (typeof first === "string" && !/^\d+$/.test(first)) return null;
  return typeof args[1] === "string" ? args[1] : "localhost";
}

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(...args) {
  const host = hostOf(args);
  if (host !== null && !LOOPBACK.test(host)) throw new Error(`loopback-guard: refused a connection to ${host}; only loopback is allowed in the offline karabast phases`);
  return connect.apply(this, args);
};

const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function guardedListen(...args) {
  if (typeof args[0] === "number" && (args.length === 1 || typeof args[1] === "function")) return listen.call(this, args[0], "127.0.0.1", ...args.slice(1));
  if (args[0] !== null && typeof args[0] === "object" && typeof args[0].port === "number" && args[0].host === undefined) return listen.call(this, { ...args[0], host: "127.0.0.1" }, ...args.slice(1));
  return listen.apply(this, args);
};

module.exports = { LOOPBACK };
