import type { PreparedDailyPlan } from "../domain/review/prepared-daily-plan.js";
import type { PreparedPlanApproval } from "../domain/review/prepared-plan-approval.js";
import type { Result } from "../domain/shared/result.js";

/** Environment-bound canonical consent storage. No execution/lease methods. */
export interface PreparedArtifactStore {
  savePrepared(prepared: PreparedDailyPlan): Result<void>;
  loadPrepared(contentHash: string): Result<PreparedDailyPlan | undefined>;
  saveApproval(approval: PreparedPlanApproval): Result<void>;
  loadApproval(contentHash: string): Result<PreparedPlanApproval | undefined>;
  close(): void;
}
