import { validateExternalRegimeEvidence } from "../domain/analytics/external-regime-evidence.js";
import type { AnalyticsEvidenceBundle } from "../domain/analytics/analytics-evidence-bundle.js";
import type { ExternalEvidenceFamily } from "../domain/analytics/analytics-profile.js";
import { issueQualityAdmission } from "../domain/quality/assess-data-quality.js";

/** Installed by application composition, never taken from an evidence payload. */
export type ControlledExternalIngestion = (
  family: ExternalEvidenceFamily,
) => unknown;

export function admissionsFromControlledIngestion(
  analytics: AnalyticsEvidenceBundle,
  issuer: string,
  ingest: ControlledExternalIngestion,
) {
  return analytics.externalEvidence.flatMap((artifact) => {
    let received: unknown;
    try {
      received = ingest(artifact.family);
    } catch {
      return [];
    }
    const validation = validateExternalRegimeEvidence(
      received,
      artifact.family,
      analytics.inputIdentity,
    );
    if (
      validation.status !== "complete" ||
      !validation.evidence ||
      validation.evidence.contentHash !== artifact.contentHash
    )
      return [];
    return [issueQualityAdmission(issuer, artifact.contentHash)];
  });
}
