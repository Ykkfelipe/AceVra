import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
} from "node:crypto";
import { chmod, readFile, stat, writeFile } from "node:fs/promises";
import type { NodePaths } from "./dataRoot.js";

export interface NodeIdentity {
  /** Ed25519 SPKI DER, base64url. Public: sent to the backend at pairing. */
  publicKey: string;
  keyId: string;
  /** Signs a UTF-8 message. The private key never leaves this closure. */
  sign(message: string): string;
}

const keyIdOf = (der: Buffer) =>
  `k_${createHash("sha256").update(der).digest().toString("base64url").slice(0, 22)}`;

function fromPrivatePem(pem: string): NodeIdentity {
  const privateKey = createPrivateKey(pem);
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("Node key must be Ed25519");
  const der = createPublicKey(privateKey).export({ type: "spki", format: "der" });
  return {
    publicKey: der.toString("base64url"),
    keyId: keyIdOf(der),
    sign: (message) => sign(null, Buffer.from(message), privateKey).toString("base64url"),
  };
}

/**
 * Loads this node's keypair or creates one on first use. The private key is generated
 * locally, written once with mode 0600 (exclusive create), and never uploaded, returned
 * by any API, or logged. Identity is NOT derived from hostname, MAC, serial or hardware.
 */
export async function loadOrCreateIdentity(paths: NodePaths): Promise<NodeIdentity> {
  try {
    if (process.platform !== "win32") {
      const mode = (await stat(paths.key)).mode & 0o777;
      if (mode & 0o077) await chmod(paths.key, 0o600); // tighten a loosened key file
    }
    return fromPrivatePem(await readFile(paths.key, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const { privateKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  await writeFile(paths.key, pem, { mode: 0o600, flag: "wx" });
  return fromPrivatePem(pem);
}
