import assert from "node:assert/strict";
import { test } from "node:test";

const {
  commandAAD, decryptRemoteControlPayload, deriveRemoteControlE2EEKey,
  deriveRemoteControlE2EEKeyFromSecret,
  encryptRemoteControlPayload, importControllerE2EEPrivateKey, p256KeyId,
} = await import("../remote-e2ee.js");

const DESKTOP_PUBLIC = "BObqW3m9_pq6hpZ9hGXTpay4vM-77jEtncU1pmOxTXiM8aJYVy-YH7hj6YXqXFUL2tD0gAZexnEdKqXQlpic1zo";
const CONTROLLER_PRIVATE = "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgBaLtBcvx2ltRIFCQCo1xEi6WEhIiPUjOpq493TKn-KGhRANCAAQtQtmPG3obCDk4fUe9sXdHVHfVcWrdi2RC40gSy4T3Ubxn42gWdNl1i9oeDQ8gc0zaXJdXrG7hLRj2ixlOPRiP";
const CONTROLLER_PUBLIC = "BC1C2Y8behsIOTh9R72xd0dUd9Vxat2LZELjSBLLhPdRvGfjaBZ02XWL2h4NDyBzTNpcl1esbuEtGPaLGU49GI8";
const STATEMENT_HASH = "a".repeat(64);

test("WebCrypto matches the Electron E2EE vector without exposing content", async () => {
  const desktopKeyId = await p256KeyId(DESKTOP_PUBLIC);
  const controllerKeyId = await p256KeyId(CONTROLLER_PUBLIC);
  const key = await deriveRemoteControlE2EEKey({ privateKey: await importControllerE2EEPrivateKey(CONTROLLER_PRIVATE), peerPublicKey: DESKTOP_PUBLIC, controlSessionId: "11111111-1111-4111-8111-111111111111", deviceId: "22222222-2222-4222-8222-222222222222", desktopKeyId, controllerKeyId, desktopStatementHash: STATEMENT_HASH, direction: "controller-to-desktop" });
  const hkdfVector = await deriveRemoteControlE2EEKeyFromSecret({ secret: new Uint8Array(32), controlSessionId: "11111111-1111-4111-8111-111111111111", deviceId: "22222222-2222-4222-8222-222222222222", desktopKeyId, controllerKeyId, desktopStatementHash: STATEMENT_HASH, direction: "controller-to-desktop", extractable: true });
  const hkdfBytes = new Uint8Array(await crypto.subtle.exportKey("raw", hkdfVector));
  assert.equal(Buffer.from(hkdfBytes).toString("base64url"), "me5LcpecGZd8B6k75o9uUOWLe9f0FKAmV72bNfBP4hU");
  const aad = commandAAD({ controlSessionId: "11111111-1111-4111-8111-111111111111", deviceId: "22222222-2222-4222-8222-222222222222", operation: "session.prompt", workspaceId: "ws_1", sessionId: "ses_1", idempotencyKey: "idem_1", desktopKeyId, desktopStatementHash: STATEMENT_HASH, controllerKeyId });
  const value = { operation: "session.prompt", payloadVersion: 1, arguments: { workspaceId: "ws_1", sessionId: "ses_1", prompt: "E2EE_CONTENT_CANARY" } };
  const encrypted = await encryptRemoteControlPayload({ key, aad, value, nonce: Uint8Array.from({ length: 12 }, (_, index) => index) });
  assert.equal(encrypted.ciphertext, "ekVOrsrn3nHHkYe2s140qMCCfLqvnqTY4JMBGzgufEP9dcYV9nhFV9qu-OEGPH_ev8TxJDhTD7zvjl5ne0nNRX3EcEkKWRlo9091o-W1T7H433K_K1wj2YcUGhMUYVjs5jTJiyZkfaGK-aYD0lseJR-WWOKjjeOhnc3rTM4g9AmnhqIeFyv0FUqckuI6JfFSraRtliZUTw");
  assert.deepEqual(await decryptRemoteControlPayload({ key, aad, payload: encrypted }), value);
  assert.doesNotMatch(JSON.stringify(encrypted), /E2EE_CONTENT_CANARY/);
});
