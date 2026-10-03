import type { AccountReadResponse } from "../../../src/adapters/bybit-v5/account-read-transport.js";
export { manualOrder, fill, tiers } from "./responses.js";
/** Synthetic provider-shaped response builder shared with fake read ports. */
export function accountReadResponse(
  result: Record<string, unknown>,
): AccountReadResponse {
  return { result, time: 1790942400000 };
}
export const accountInfoResponse = accountReadResponse({
  unifiedMarginStatus: 5,
  marginMode: "REGULAR_MARGIN",
  spotHedgingStatus: "OFF",
});
// Restrictions/USD-equity basis are absent in the provider contract. These
// fixtures intentionally retain that uncertainty instead of proving completeness.
export const walletResponse = accountReadResponse({
  list: [
    {
      accountType: "UNIFIED",
      totalEquity: "100",
      totalWalletBalance: "100",
      totalMarginBalance: "100",
      totalPerpUPL: "0",
      totalAvailableBalance: "100",
      totalInitialMargin: "0",
      totalMaintenanceMargin: "0",
      accountIMRate: "0",
      accountMMRate: "0",
      coin: [
        {
          coin: "USDC",
          walletBalance: "100",
          equity: "100",
          usdValue: "100",
          locked: "0",
          bonus: "0",
          borrowAmount: "0",
          spotBorrow: "0",
          accruedInterest: "0",
          totalOrderIM: "0",
          totalPositionIM: "0",
          totalPositionMM: "0",
          unrealisedPnl: "0",
          marginCollateral: true,
          collateralSwitch: true,
        },
      ],
    },
  ],
});
export const collateralResponse = accountReadResponse({
  list: [
    {
      currency: "USDC",
      marginCollateral: true,
      collateralSwitch: true,
      borrowable: true,
      borrowAmount: "0",
      otherBorrowAmount: "0",
      maxBorrowingAmount: "1000",
      hourlyBorrowRate: "0",
    },
  ],
});
export const tierResponse = accountReadResponse({
  list: [
    {
      currency: "USDC",
      collateralRatioList: [{ minQty: "0", maxQty: "", collateralRatio: "1" }],
    },
  ],
});
