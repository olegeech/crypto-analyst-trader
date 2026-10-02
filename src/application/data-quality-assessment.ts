import { rehydrateAnalyticsEvidenceBundle } from "../domain/analytics/analytics-evidence-bundle.js";
import {
  assessDataQuality,
  type AssessDataQualityInput,
} from "../domain/quality/assess-data-quality.js";
import { createQualityProfile } from "../domain/quality/quality-profile.js";
import { requireIdentifier } from "../domain/shared/validation.js";
import { ok, type Result } from "../domain/shared/result.js";
import type { DataQualityAssessment } from "../domain/quality/data-quality-assessment.js";
import {
  admissionsFromControlledIngestion,
  type ControlledExternalIngestion,
} from "./data-quality-admission.js";

export interface DataQualityBoundary {
  readonly assess: (
    input: Omit<AssessDataQualityInput, "profile" | "externalAdmissions">,
  ) => Result<DataQualityAssessment>;
}
/** Configuration is application-owned. This is not an external JSON ingestion API. */
export function createDataQualityBoundary(configuration: {
  readonly qualityProfile: unknown;
  readonly issuer: string;
  readonly ingestExternal?: ControlledExternalIngestion;
}): Result<DataQualityBoundary> {
  const profile = createQualityProfile(configuration.qualityProfile);
  const issuer = requireIdentifier(configuration.issuer, "issuer");
  if (!profile.ok) return profile;
  if (!issuer.ok) return issuer;
  const ingest = configuration.ingestExternal;
  return ok(
    Object.freeze({
      assess: (
        input: Omit<AssessDataQualityInput, "profile" | "externalAdmissions">,
      ) => {
        const admissions =
          ingest === undefined
            ? []
            : input.sources.flatMap((source) => {
                if (source.role !== "analytics") return [];
                const parsed = rehydrateAnalyticsEvidenceBundle(source.value);
                return parsed.ok
                  ? admissionsFromControlledIngestion(
                      parsed.value,
                      issuer.value,
                      ingest,
                    )
                  : [];
              });
        // Explicit fields prevent a JSON caller from overriding profile or admission authority.
        return assessDataQuality({
          profile: profile.value,
          sources: input.sources,
          bundleCutoff: input.bundleCutoff,
          evaluationTime: input.evaluationTime,
          externalAdmissions: admissions,
        });
      },
    }),
  );
}
