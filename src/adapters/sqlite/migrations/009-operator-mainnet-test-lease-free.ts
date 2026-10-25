import type { DatabaseSync } from "node:sqlite";

/** Remove lease projections while preserving historical canonical intent bytes. */
export const operatorMainnetTestLeaseFreeMigration = {
  version: 9,
  name: "operator-mainnet-test-lease-free",
  apply(database: DatabaseSync): void {
    database.exec(`
      ALTER TABLE operator_mainnet_test_write_intents DROP COLUMN lease_owner_run_id;
      ALTER TABLE operator_mainnet_test_write_intents DROP COLUMN lease_epoch;
    `);
  },
} as const;
