// Preloaded into a child process to PROVE it makes no network request: any attempt to connect throws.
const net = require("net"), tls = require("tls"), dns = require("dns");
const stop = (what) => () => { throw new Error("NETWORK BLOCKED: " + what); };
globalThis.fetch = stop("fetch");
net.Socket.prototype.connect = stop("net.connect");
tls.connect = stop("tls.connect");
dns.lookup = stop("dns.lookup");
