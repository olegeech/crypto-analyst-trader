import type { CredentialEnvironment } from "./credential-provider.js";
import type { Result } from "../domain/shared/result.js";

/** Private local key used only to authenticate persisted wallet-capture facts. */
export interface HistoryAccountingAnchorKeyProvider {
  read(environment: CredentialEnvironment): Promise<Result<Uint8Array>>;
  getOrCreate(environment: CredentialEnvironment): Promise<Result<Uint8Array>>;
}
