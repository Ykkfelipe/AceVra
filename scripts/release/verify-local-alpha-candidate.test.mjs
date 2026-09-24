import assert from "node:assert/strict";
import test from "node:test";

import { extractCertificateRoot } from "./verify-local-alpha-candidate.mjs";

test("extracts the certificate root from codesign designated-requirement output", () => {
  const text =
    'designated requirement = identifier "com.acevra.desktop" and certificate root = H"e67964f24cb4f07494050839d1653637c06e7a7c"';
  assert.equal(extractCertificateRoot(text), "e67964f24cb4f07494050839d1653637c06e7a7c");
});

test("does not treat an ad-hoc CDHash requirement as certificate-root anchored", () => {
  assert.equal(
    extractCertificateRoot(
      'designated requirement = cdhash H"9251b6f7864f0b13af5d1d1b8bc0594c7a68cec6"',
    ),
    null,
  );
});
