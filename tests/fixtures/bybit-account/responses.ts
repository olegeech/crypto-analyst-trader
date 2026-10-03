// Synthetic provider-shaped records; no authenticated account data.
export const manualOrder = {
  symbol: "ETHUSDC",
  orderId: "manual-1",
  orderLinkId: "",
  orderStatus: "FutureStatus",
  side: "Buy",
  orderType: "Limit",
  qty: "1",
  price: "10",
  cumExecQty: "0",
  leavesQty: "1",
  positionIdx: 2,
  reduceOnly: false,
  triggerPrice: "12",
  stopOrderType: "FutureConditional",
  createdTime: "1790942400000",
};
export const fill = {
  symbol: "ETH-30OCT26-3000-C",
  execId: "fill-1",
  orderId: "manual-1",
  orderLinkId: "",
  side: "Sell",
  execType: "FutureSpread",
  execTime: "1790942400000",
  execPrice: "10",
  execQty: "1",
  execFee: "-0.01",
  feeCurrency: "",
  feeRate: "0",
  execFeeV2: "0",
  extraFees:
    '[{"feeCoin":"USDC","feeType":"FutureTax","subFeeType":"FutureSubTax","feeRate":"0.01","fee":"0.1"}]',
};
export const tiers = [
  {
    coin: "ETH",
    collateralRatio: "0.99",
    tiers: [
      { minQty: "10", maxQty: "", ratio: "0.8" },
      { minQty: "0", maxQty: "10", ratio: "0.9" },
    ],
  },
];
