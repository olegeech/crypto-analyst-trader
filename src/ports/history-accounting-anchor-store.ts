import type {
  AccountAssetEvidence,
  AccountBinding,
  AccountCredentialPosture,
  AccountTotalsEvidence,
} from "../domain/account/account-evidence-bundle.js";
import type { Result } from "../domain/shared/result.js";
import type { UtcTimestamp } from "../domain/shared/time.js";
import type { HistoryStoreScope } from "./history-store.js";

/**
 * A reduced, allowlisted wallet-balance observation captured through the
 * authenticated Bybit GET boundary. Raw provider payloads and credentials are
 * deliberately excluded.
 */
export interface HistoryAccountingWalletAnchor {
  readonly schemaVersion: "history-accounting-wallet-anchor/v1";
  readonly anchorId: string;
  readonly kind: "opening" | "closing";
  readonly scope: HistoryStoreScope;
  readonly accountBinding: AccountBinding;
  readonly credentialPosture: AccountCredentialPosture;
  readonly capture: {
    readonly identityEndpoint: "/v5/user/query-api";
    readonly walletEndpoint: "/v5/account/wallet-balance";
    readonly accountType: "UNIFIED";
    readonly identityObservedAt: UtcTimestamp;
    readonly collectionStartedAt: UtcTimestamp;
    readonly collectionEndedAt: UtcTimestamp;
    readonly providerTimeBefore: UtcTimestamp;
    readonly providerResponseTime: UtcTimestamp;
    readonly providerTimeAfter: UtcTimestamp;
  };
  readonly totals: AccountTotalsEvidence;
  readonly assets: readonly AccountAssetEvidence[];
  readonly contentHash: string;
  readonly recordedAt: UtcTimestamp;
}

export interface AppendHistoryAccountingWalletAnchorRequest {
  /** recordedAt and contentHash are assigned by the SQLite store. */
  readonly anchor: Omit<
    HistoryAccountingWalletAnchor,
    "contentHash" | "recordedAt"
  >;
}

export interface HistoryAccountingWalletAnchorStorePort {
  append(
    request: AppendHistoryAccountingWalletAnchorRequest,
  ): Result<HistoryAccountingWalletAnchor>;
  read(
    scope: HistoryStoreScope,
    anchorId: string,
  ): Result<HistoryAccountingWalletAnchor | undefined>;
  /** Resolve an explicit operator-selected immutable ID without live reads. */
  readById(anchorId: string): Result<HistoryAccountingWalletAnchor | undefined>;
  list(
    scope: HistoryStoreScope,
  ): Result<readonly HistoryAccountingWalletAnchor[]>;
}
