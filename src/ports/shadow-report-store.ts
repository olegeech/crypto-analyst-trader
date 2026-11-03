import type { ShadowMarketReport } from "../domain/review/shadow-market-report.js";
import type { Result } from "../domain/shared/result.js";

/** Public, environment-bound immutable report storage; never account scoped. */
export interface ShadowReportStore {
  saveShadowReport(report: ShadowMarketReport): Result<void>;
  loadShadowReport(contentHash: string): Result<ShadowMarketReport | undefined>;
  close(): void;
}
