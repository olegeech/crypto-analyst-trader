import {
  LIQUIDATION_EVIDENCE_V2_PROVIDER_SEMANTIC_IDENTITY,
  LIQUIDATION_EVIDENCE_V2_SCHEMA_VERSION,
  type LiquidationEvidenceBundleV2Input,
} from "../../src/domain/liquidation/liquidation-evidence-bundle.js";
import { liquidationEvidenceV1GoldenInput } from "./liquidation-evidence-v1-golden.js";

/** Captured before v3 implementation; changing it changes historical v2 identity. */
export const LIQUIDATION_EVIDENCE_V2_GOLDEN_HASH =
  "sha256:e483fa32602eb774fe127ee0fa2cd125f4dbf950908f74e71cd6207e42027be7" as const;

export function liquidationEvidenceV2GoldenInput(): LiquidationEvidenceBundleV2Input {
  const legacy = liquidationEvidenceV1GoldenInput();
  return {
    ...legacy,
    schemaVersion: LIQUIDATION_EVIDENCE_V2_SCHEMA_VERSION,
    providerSemanticIdentity:
      LIQUIDATION_EVIDENCE_V2_PROVIDER_SEMANTIC_IDENTITY,
    targets: legacy.targets.map((target) => ({
      ...target,
      constituents: target.constituents.map((constituent) => ({
        ...constituent,
        observations: constituent.observations.map((observation) => ({
          ...observation,
          provenance: "provider-explicit" as const,
        })),
      })),
    })),
  };
}
