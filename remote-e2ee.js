export const E2EE_MODE = "e2ee-v1";
export const E2EE_ALGORITHM = "P-256/HKDF-SHA-256/AES-256-GCM";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const KEY_ID = /^p256:[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const bytesToBase64Url = (bytes) => {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};
const base64UrlToBytes = (value) => {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) throw new TypeError("Invalid base64url value");
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((value.length + 3) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

export function canonicalRemoteControlAAD(metadata) {
  if (!object(metadata)) throw new TypeError("Invalid encryption metadata");
  const entries = Object.entries(metadata).sort(([left], [right]) => left.localeCompare(right));
  for (const [key, value] of entries) if (!/^[A-Za-z][A-Za-z0-9]*$/.test(key) || !(value === null || typeof value === "string" || Number.isSafeInteger(value))) throw new TypeError("Invalid encryption metadata");
  return encoder.encode(`jugglework.desktop-remote.e2ee-v1\n${JSON.stringify(Object.fromEntries(entries))}\n`);
}

export async function p256KeyId(publicKey) {
  const raw = typeof publicKey === "string" ? base64UrlToBytes(publicKey) : new Uint8Array(publicKey);
  if (raw.length !== 65 || raw[0] !== 4) throw new TypeError("Invalid P-256 public key");
  return `p256:${bytesToBase64Url(await crypto.subtle.digest("SHA-256", raw))}`;
}

export function canonicalDesktopE2EEKeyStatement({ deviceId, signingIdentity, keyId, publicKey, algorithm, createdAt }) {
  if (!UUID.test(deviceId) || !KEY_ID.test(keyId) || algorithm !== E2EE_ALGORITHM ||
      signingIdentity?.algorithm !== "Ed25519" || !UUID.test(signingIdentity?.keyId) || !SHA256.test(signingIdentity?.fingerprint) ||
      typeof createdAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(createdAt) || new Date(createdAt).toISOString() !== createdAt) {
    throw new TypeError("Invalid signed Desktop key binding");
  }
  const signingPublicKey = base64UrlToBytes(signingIdentity.publicKey);
  const e2eePublicKey = base64UrlToBytes(publicKey);
  if (signingPublicKey.length !== 32 || e2eePublicKey.length !== 65 || e2eePublicKey[0] !== 4) throw new TypeError("Invalid signed Desktop key material");
  return `jugglework.desktop-remote.e2ee-key-advertisement.v1\ndeviceId=${deviceId}\nsigningAlgorithm=Ed25519\nsigningKeyId=${signingIdentity.keyId}\nsigningKeyFingerprint=${signingIdentity.fingerprint}\ne2eeKeyId=${keyId}\ne2eePublicKey=${publicKey}\ne2eeAlgorithm=${algorithm}\ncreatedAt=${createdAt}\n`;
}

export async function verifyDesktopE2EEKeyAdvertisement(advertisement, deviceId) {
  const keys = ["algorithm", "createdAt", "keyId", "mode", "publicKey", "signature", "signedStatement", "signingIdentity", "statementHash"];
  if (!object(advertisement) || Object.keys(advertisement).sort().join("\0") !== keys.sort().join("\0") || advertisement.mode !== E2EE_MODE ||
      !object(advertisement.signingIdentity) || Object.keys(advertisement.signingIdentity).sort().join("\0") !== "algorithm\0fingerprint\0keyId\0publicKey") {
    throw new TypeError("Invalid signed Desktop key advertisement");
  }
  const statement = canonicalDesktopE2EEKeyStatement({ deviceId, ...advertisement });
  const [keyId, fingerprintDigest, statementDigest] = await Promise.all([
    p256KeyId(advertisement.publicKey),
    crypto.subtle.digest("SHA-256", base64UrlToBytes(advertisement.signingIdentity.publicKey)),
    crypto.subtle.digest("SHA-256", encoder.encode(statement)),
  ]);
  const fingerprint = [...new Uint8Array(fingerprintDigest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const statementHash = [...new Uint8Array(statementDigest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  if (keyId !== advertisement.keyId || fingerprint !== advertisement.signingIdentity.fingerprint ||
      statement !== advertisement.signedStatement || statementHash !== advertisement.statementHash) {
    throw new TypeError("Signed Desktop key identifiers do not match");
  }
  const signingKey = await crypto.subtle.importKey("raw", base64UrlToBytes(advertisement.signingIdentity.publicKey), { name: "Ed25519" }, false, ["verify"]);
  if (!await crypto.subtle.verify("Ed25519", signingKey, base64UrlToBytes(advertisement.signature), encoder.encode(statement))) {
    throw new TypeError("Invalid Desktop key signature");
  }
  return Object.freeze({ ...advertisement, signingIdentity: Object.freeze({ ...advertisement.signingIdentity }) });
}

export function formatE2EEFingerprint(fingerprint) {
  if (!SHA256.test(fingerprint)) throw new TypeError("Invalid fingerprint");
  return fingerprint.match(/.{1,4}/g).join(" ");
}

export async function createControllerE2EEKey() {
  const keyPair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const publicKey = bytesToBase64Url(await crypto.subtle.exportKey("raw", keyPair.publicKey));
  return Object.freeze({ keyId: await p256KeyId(publicKey), publicKey, privateKey: keyPair.privateKey });
}

export async function importControllerE2EEPrivateKey(pkcs8) {
  return crypto.subtle.importKey("pkcs8", base64UrlToBytes(pkcs8), { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
}

export async function deriveRemoteControlE2EEKey({ privateKey, peerPublicKey, controlSessionId, deviceId, desktopKeyId, controllerKeyId, desktopStatementHash, direction }) {
  if (!KEY_ID.test(desktopKeyId) || !KEY_ID.test(controllerKeyId) || !SHA256.test(desktopStatementHash) || !["controller-to-desktop", "desktop-to-controller"].includes(direction)) throw new TypeError("Invalid encryption binding");
  const peer = await crypto.subtle.importKey("raw", base64UrlToBytes(peerPublicKey), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const secret = await crypto.subtle.deriveBits({ name: "ECDH", public: peer }, privateKey, 256);
  return deriveRemoteControlE2EEKeyFromSecret({ secret, controlSessionId, deviceId, desktopKeyId, controllerKeyId, desktopStatementHash, direction });
}

export async function deriveRemoteControlE2EEKeyFromSecret({ secret, controlSessionId, deviceId, desktopKeyId, controllerKeyId, desktopStatementHash, direction, extractable = false }) {
  if (!KEY_ID.test(desktopKeyId) || !KEY_ID.test(controllerKeyId) || !SHA256.test(desktopStatementHash) || !["controller-to-desktop", "desktop-to-controller"].includes(direction) || secret.byteLength !== 32) throw new TypeError("Invalid encryption binding");
  const salt = await crypto.subtle.digest("SHA-256", encoder.encode(`jugglework.desktop-remote.e2ee-v1\n${controlSessionId}\n${deviceId}\n`));
  const hkdf = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt, info: encoder.encode(`${desktopKeyId}\n${controllerKeyId}\n${desktopStatementHash}\n${direction}\n`) }, hkdf, { name: "AES-GCM", length: 256 }, extractable, ["encrypt", "decrypt"]);
}

export async function encryptRemoteControlPayload({ key, aad, value, nonce = crypto.getRandomValues(new Uint8Array(12)) }) {
  if (nonce.byteLength !== 12) throw new TypeError("Invalid AES-GCM nonce");
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: aad, tagLength: 128 }, key, encoder.encode(JSON.stringify(value)));
  return { nonce: bytesToBase64Url(nonce), ciphertext: bytesToBase64Url(ciphertext) };
}

export async function decryptRemoteControlPayload({ key, aad, payload }) {
  if (!object(payload) || Object.keys(payload).sort().join("\0") !== "ciphertext\0nonce") throw new TypeError("Invalid encrypted payload");
  const nonce = base64UrlToBytes(payload.nonce);
  if (nonce.length !== 12) throw new TypeError("Invalid AES-GCM nonce");
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce, additionalData: aad, tagLength: 128 }, key, base64UrlToBytes(payload.ciphertext));
  return JSON.parse(decoder.decode(plaintext));
}

export function commandAAD({ controlSessionId, deviceId, operation, workspaceId = null, sessionId = null, idempotencyKey, desktopKeyId, desktopStatementHash, controllerKeyId }) {
  return canonicalRemoteControlAAD({ kind: "command", protocolVersion: 1, payloadVersion: 1, controlSessionId, deviceId, operation, workspaceId, sessionId, idempotencyKey, desktopKeyId, desktopStatementHash, controllerKeyId });
}

export async function sha256Hex(value) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function commandResultAAD({ commandId, controlSessionId, deviceId, operation, status, desktopKeyId, desktopStatementHash, controllerKeyId }) {
  return canonicalRemoteControlAAD({ kind: "command-result", protocolVersion: 1, payloadVersion: 1, commandId, controlSessionId, deviceId, operation, status, desktopKeyId, desktopStatementHash, controllerKeyId });
}

export function sessionEventAAD({ eventId, controlSessionId, deviceId, workspaceId, sessionId, sourceSequence, eventType, occurredAt, desktopKeyId, desktopStatementHash, controllerKeyId }) {
  return canonicalRemoteControlAAD({ kind: "session-event", protocolVersion: 1, payloadVersion: 1, eventId, controlSessionId, deviceId, workspaceId, sessionId, sourceSequence, eventType, occurredAt, desktopKeyId, desktopStatementHash, controllerKeyId });
}
