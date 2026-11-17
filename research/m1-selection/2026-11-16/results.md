# M1 shared capital research

**reject — no demonstrably better selector yet**

| Set | Variant | Return | Drawdown | TP closes | Capital in use | Missed-signal days | Slot-hours below entry |
|---|---|---:|---:|---:|---:|---:|---:|
| set-a | three | 37.64% | 27.78% | 231 | 28.72% | 52 | 19971 |
| set-a | five | 34.55% | 15.44% | 313 | 19.62% | 19 | 22869 |
| set-a | fixed | 13.49% | 5.44% | 104 | 5.76% | 0 | 6614 |
| set-a | without_best (INJUSDT) | 31.45% | 26.76% | 221 | 26.46% | 44 | 18208 |
| set-b | three | 9.66% | 34.98% | 128 | 47.93% | 90 | 39728 |
| set-b | five | 7.72% | 19.98% | 153 | 35.83% | 53 | 64208 |
| set-b | fixed | 3.43% | 6.50% | 82 | 6.47% | 0 | 8350 |
| set-b | without_best (VVVUSDT) | -1.97% | 33.76% | 95 | 49.19% | 81 | 39608 |
| reference | three | 29.86% | 11.69% | 160 | 24.00% | 68 | 29664 |
| reference | five | 27.22% | 8.27% | 234 | 19.94% | 30 | 38635 |
| reference | fixed | 3.43% | 6.50% | 82 | 6.47% | 0 | 8350 |
| reference | with_excluded | 28.46% | 11.69% | 175 | 24.87% | 121 | 32530 |

The snapshot applies current turnover leaders and their rank to past markets. This bias is stronger in set A, which also has fewer eligible instruments during the period. Set B covers the reference period on different instruments. The strict quorum was selected after #163. The #163 signal and hourly fill approximations still apply. Historical evidence is not a profit guarantee.
