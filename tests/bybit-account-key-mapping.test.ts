import assert from "node:assert/strict";
import test from "node:test";
import { mapAccountReadIdentity } from "../src/adapters/bybit-v5/account-key-mapper.js";
import { BybitAccountReadError } from "../src/adapters/bybit-v5/account-read-transport.js";
import { mapAccountKeyMetadata } from "../src/adapters/bybit-v5/read-mappers.js";

const at = "2026-10-03T12:00:00.000Z";
const response = () => ({
  time: 1700000000000,
  result: {
    userID: 123,
    parentUid: "999",
    readOnly: 1,
    permissions: { ContractTrade: [], Spot: [], Wallet: [] },
    ips: [],
    expiredAt: "",
    apiKey: "private-sentinel-key",
    secret: "private-sentinel-secret",
  },
});

test("read-only identity authenticates actual subaccount without requiring write permissions", () => {
  const output = mapAccountReadIdentity(response(), "123", "demo", at);
  assert.equal(output.credentialPosture.readOnly, true);
  assert.equal(output.credentialPosture.permissions.contractOrder, false);
  assert.equal(output.accountBinding.environment, "demo");
  assert.match(
    output.accountBinding.accountIdentityHash,
    /^sha256:[0-9a-f]{64}$/u,
  );
  assert.deepEqual(output.credentialPosture.warnings, ["API_KEY_IP_UNBOUND"]);
  assert.doesNotMatch(
    JSON.stringify(output),
    /private-sentinel|parentUid|userID|"999"/u,
  );
  assert.throws(
    () => mapAccountReadIdentity(response(), "999", "demo", at),
    (e: unknown) =>
      e instanceof BybitAccountReadError &&
      e.code === "ACCOUNT_IDENTITY_MISMATCH",
  );
  assert.throws(() =>
    mapAccountKeyMetadata({ ...response(), retCode: 0, retMsg: "" }, "123"),
  );
});

test("environment identities stay isolated and unknown environment fails", () => {
  const outputs = (["demo", "testnet", "mainnet"] as const).map((env) =>
    mapAccountReadIdentity(response(), "123", env, at),
  );
  assert.equal(
    new Set(outputs.map((x) => x.accountBinding.accountIdentityHash)).size,
    3,
  );
  assert.throws(() =>
    mapAccountReadIdentity(response(), "123", "unexpected" as never, at),
  );
});

test("all wallet transfer permission labels are conservatively treated as write authority", () => {
  for (const permission of [
    "AccountTransfer",
    "SubMemberTransfer",
    "SubMemberTransferList",
  ]) {
    const input = response();
    input.result.permissions.Wallet = [permission] as never;
    assert.equal(
      mapAccountReadIdentity(input, "123", "testnet", at).credentialPosture
        .permissions.walletTransfer,
      true,
      permission,
    );
  }
  const input = response();
  input.result.permissions.Wallet = ["Withdraw"] as never;
  assert.throws(
    () => mapAccountReadIdentity(input, "123", "demo", at),
    (e: unknown) =>
      e instanceof BybitAccountReadError &&
      e.code === "WITHDRAWAL_PERMISSION_FORBIDDEN",
  );
});

test("IP and expiry metadata are sanitized and malformed permissions fail closed", () => {
  const input = response();
  input.result.ips = ["192.0.2.1"] as never;
  input.result.expiredAt = "2027-01-01T00:00:00Z";
  const output = mapAccountReadIdentity(input, "123", "mainnet", at);
  assert.equal(output.credentialPosture.ipBound, true);
  assert.equal(output.credentialPosture.expiresAt, "2027-01-01T00:00:00.000Z");
  assert.doesNotMatch(JSON.stringify(output), /192\.0\.2\.1/u);
  for (const value of [
    null,
    { ContractTrade: [], Spot: [], Wallet: null },
    { ContractTrade: [], Spot: [], Wallet: [{}] },
  ]) {
    assert.throws(
      () =>
        mapAccountReadIdentity(
          { ...input, result: { ...input.result, permissions: value } },
          "123",
          "demo",
          at,
        ),
      (e: unknown) =>
        e instanceof BybitAccountReadError && e.code === "INVALID_RESPONSE",
    );
  }
});

test("identity rejects unsafe numeric IDs, conflicting int64 claims and malformed expiry", () => {
  const input = response();
  assert.throws(() =>
    mapAccountReadIdentity(
      {
        ...input,
        result: { ...input.result, userID: Number.MAX_SAFE_INTEGER + 1 },
      },
      "123",
      "demo",
      at,
    ),
  );
  assert.throws(() =>
    mapAccountReadIdentity(
      { ...input, result: { ...input.result, userIDInt64: "456" } },
      "123",
      "demo",
      at,
    ),
  );
  assert.throws(() =>
    mapAccountReadIdentity(
      { ...input, result: { ...input.result, expiredAt: "bad" } },
      "123",
      "demo",
      at,
    ),
  );
  const wide = mapAccountReadIdentity(
    {
      ...input,
      result: {
        ...input.result,
        userIDInt64: "9007199254740993",
        userID: Number.MAX_SAFE_INTEGER + 1,
      },
    },
    "9007199254740993",
    "demo",
    at,
  );
  assert.match(wide.accountBinding.accountIdentityHash, /sha256/u);
});
