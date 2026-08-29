# Screen-share maxBitrate causal A/B — 2026-08-29

Baseline: `artifacts/bench-m150-recovery-persistence-screen-150s-2026-08-29.json`.

Raw evidence: `artifacts/bench-m150-cap-ab-screen-2026-08-29.json`.

Scenario: performance, 1 viewer, screen capture, default backend, no network emulation, no artificial GPU load, quality samples 0, warmup 0, one 150 s run, 250 ms sampling.

## Result

Classification: **A**.

The isolated cap increase is materially causal for the GCC estimate plateau:

- immediately before intervention, `availableOutgoingBitrate` was 3,626,673 bps and the sender cap was 2,000,000 bps;
- at 87.252 s, only `RTCRtpSender.encoding.maxBitrate` was changed from 2,000,000 to 5,500,000 bps; scale remained 2 and maxFramerate remained 60;
- the first sampled value above the 5.04 Mbps spatial-recovery gate was 5,651,633 bps at 88.250 s;
- `networkRecoveryReady` became true on the next controller observation at 89.500 s, with 6,162,934 bps and headroom 1.3695;
- the estimate continued growing to a maximum of 9,920,717 bps at 128.750 s and remained there through the end.

This is not evidence that raising the cap alone completes spatial recovery. The controller did not execute 360p60 → 540p60: after the network gate became true, `stableSamples` remained 0 because capture/encode stayed around 56.7–57.3 FPS, below the performance stability gate for a 60 FPS target.

## Timeline

| Elapsed | State and causal fields |
|---:|---|
| 86.500 s | level 2, temporal 0, scale 2, maxFramerate 60, cap 2.000 Mbps, available 3.627 Mbps, network/transport pressure false, `networkRecoveryReady=true`. |
| 87.252 s | Intervention: cap 2.000 → 5.500 Mbps; scale 2 and maxFramerate 60 unchanged. |
| 87.500 s | available 4.939 Mbps; encode/send stats approximately 57/61 FPS; no loss/retransmission. |
| 88.000 s | controller recalculated next spatial demand at 4.500 Mbps; cached headroom 1.1096 and `networkRecoveryReady=false`. |
| 88.250 s | available 5.652 Mbps, first sampled crossing of the 5.04 Mbps requirement; cached controller gate had not updated yet. |
| 89.500 s | available 6.163 Mbps, headroom 1.3695, `networkRecoveryReady=true`; `stableSamples=0`. |
| 101.251 s | available 9.052 Mbps, also above the 8.96 Mbps threshold for the following spatial step, but no spatial transition occurred. |
| 128.750 s | maximum available 9.921 Mbps; cap 5.500 Mbps; scale still 2; maxFramerate 60; `stableSamples=0`. |
| 149.750 s | available 9.921 Mbps; capture 56.67 FPS; encode 57.34 FPS; scale still 2; no spatial recovery. |

## Before/after transport behavior

- Pre-intervention plateau window (70–87.252 s): available max 3.627 Mbps; sent bitrate median 1.969 Mbps, max 2.347 Mbps.
- First 30 s after intervention: available max 9.873 Mbps; sent bitrate median 4.764 Mbps, max 6.620 Mbps; encode/send median approximately 57/56.4 FPS.
- Remainder of run: available max 9.921 Mbps; sent bitrate median 4.686 Mbps, max 6.735 Mbps; encode/send remained approximately 57/56.4 FPS.
- Receiver decode/render in the first 30 s after intervention were approximately 57.0/57.0 FPS; both remained approximately 57 FPS afterward.
- Packet loss, retransmission, and `packetsDiscardedOnSend` stayed at zero.
- Pacer delay had no sustained pressure: post-intervention p95 was approximately 0.0011 ms; one short 0.218 ms sample occurred around 88.25 s.

The temporary diagnostic harness reapplied 5.5 Mbps when the normal 1.5 s controller loop restored 2 Mbps: 43 successful cap repairs, zero errors. It restored the original 2 Mbps cap during cleanup. The diagnostic patch was then removed completely; the synchronized code state remains `dfe245c7af9b09f3380461974a5b7621c08fb70c`.
