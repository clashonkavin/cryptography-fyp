# Gas Benchmark Report

- Generated at: `2026-04-09T17:16:13.398Z`
- Minimum required improvement: `5%`
- Passes: `5/5`
- Mean total-gas improvement: `38.84%`
- Mean runtime-gas improvement: `46.95%`
- Mean submit-gas improvement: `50.66%`

## Scenario Results

| Scenario | New total gas | Old total gas | Delta (old-new) | Improvement | Pass |
|---|---:|---:|---:|---:|:---:|
| Small majority (5 contractors) | 6,145,573 | 9,594,323 | 3,448,750 | 35.95% | YES |
| Large majority (8 contractors) | 8,466,267 | 14,117,204 | 5,650,937 | 40.03% | YES |
| Split vote (6 contractors) | 6,893,943 | 11,076,794 | 4,182,851 | 37.76% | YES |
| All equal (7 contractors) | 7,706,276 | 12,623,100 | 4,916,824 | 38.95% | YES |
| Higher variance (10 contractors) | 10,028,782 | 17,147,715 | 7,118,933 | 41.52% | YES |

| Scenario | New runtime gas | Old runtime gas | Runtime improvement | New submit gas | Old submit gas | Submit improvement |
|---|---:|---:|---:|---:|---:|---:|
| Small majority (5 contractors) | 4,250,919 | 7,921,501 | 46.34% | 3,584,172 | 7,255,168 | 50.60% |
| Large majority (8 contractors) | 6,571,613 | 12,444,382 | 47.19% | 5,714,232 | 11,587,888 | 50.69% |
| Split vote (6 contractors) | 4,999,289 | 9,403,972 | 46.84% | 4,294,248 | 8,699,448 | 50.64% |
| All equal (7 contractors) | 5,811,622 | 10,950,278 | 46.93% | 5,004,228 | 10,143,632 | 50.67% |
| Higher variance (10 contractors) | 8,134,128 | 15,474,893 | 47.44% | 7,134,276 | 14,476,304 | 50.72% |

## Per-Tx Mean Gas (all scenarios)

| Metric | New | Old |
|---|---:|---:|
| Deploy | 1,894,654 | 1,672,822 |
| Create task | 194,479 | 194,560 |
| Submit result | 714,754 | 1,448,957 |
| Finalize task | 612,804 | 611,957 |

