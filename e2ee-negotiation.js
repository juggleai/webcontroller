import { createControllerE2EEKey, deriveRemoteControlE2EEKey, verifyDesktopE2EEKeyAdvertisement } from "./remote-e2ee.js";

export async function negotiateEncryptedControlSession({ device, workspaceId = null, sessionId = null, request }) {
  if (device?.payloadEncryption?.mode !== "e2ee-v1" || !device.capabilities?.features?.includes?.("payload.e2ee-v1")) {
    throw new Error("Desktop did not advertise required end-to-end encryption");
  }
  const desktop = await verifyDesktopE2EEKeyAdvertisement(device.payloadEncryption, device.id);
  const controller = await createControllerE2EEKey();
  const controlSession = await request("/v1/desktop-control-sessions", {
    method: "POST",
    body: {
      schemaVersion: 1, deviceId: device.id, workspaceId, sessionId, mode: "view",
      payloadEncryption: { mode: "e2ee-v1", desktopKeyId: desktop.keyId, controllerKeyId: controller.keyId, controllerPublicKey: controller.publicKey },
    },
  });
  const binding = controlSession?.payloadEncryption;
  if (!controlSession?.id || controlSession.deviceId !== device.id || binding?.mode !== "e2ee-v1" ||
      binding.desktopKeyId !== desktop.keyId || binding.desktopPublicKey !== desktop.publicKey ||
      binding.desktopStatementHash !== desktop.statementHash || binding.desktopSignedStatement !== desktop.signedStatement ||
      binding.desktopSignature !== desktop.signature || JSON.stringify(binding.desktopSigningIdentity) !== JSON.stringify(desktop.signingIdentity) ||
      binding.controllerKeyId !== controller.keyId) {
    throw new Error("Control session encryption binding is invalid");
  }
  const keyBinding = {
    privateKey: controller.privateKey, peerPublicKey: desktop.publicKey, controlSessionId: controlSession.id,
    deviceId: device.id, desktopKeyId: desktop.keyId, desktopStatementHash: desktop.statementHash, controllerKeyId: controller.keyId,
  };
  return {
    controlSession,
    encryption: Object.freeze({
      desktopKeyId: desktop.keyId, desktopStatementHash: desktop.statementHash, controllerKeyId: controller.keyId,
      desktopPublicKey: desktop.publicKey, desktopSignedStatement: desktop.signedStatement,
      desktopSigningIdentity: desktop.signingIdentity, controllerPrivateKey: controller.privateKey,
      inboundKey: await deriveRemoteControlE2EEKey({ ...keyBinding, direction: "desktop-to-controller" }),
      outboundKey: await deriveRemoteControlE2EEKey({ ...keyBinding, direction: "controller-to-desktop" }),
    }),
  };
}

export function immutableEncryptionBinding(controlSession, encryption) {
  return controlSession?.id && encryption
    ? `${controlSession.id}\0${encryption.desktopKeyId}\0${encryption.desktopStatementHash}\0${encryption.controllerKeyId}`
    : null;
}
