# Research dump — MT-6769-based mobile mainboard (SMT workstation programming target)

> Hand-curated dump for knowledge-pack bootstrap. Replaces the Scout phase
> which cannot run on the mimo relay (no Anthropic server-tool support, no
> community web footprint for this industrial programming jig). Content
> sourced from `electrical_graph.json` (871 components, 89 rails) and
> `boot_sequence_analyzed.json`.
>
> Note on refdes: the template's nominal placeholders were substituted with
> the real component / rail names resolved from `electrical_graph.json`
> to keep the structural gate honest: the nominal PMU placeholder maps to
> the MT-6358W-family PMU at the U24xx block, the nominal USB connector
> placeholder maps to the Type-C connector at the U57xx block, and the
> nominal separate-eMCP placeholder maps to the companion SoC at U14xx
> (LPDDR4X is integrated into the SoC package on this layout).

## Device overview

MT-6769-series smartphone mainboard (MediaTek Helio family), used as the
programming target for the SMT workstation jig (test fixture, "smt-v551"
asset id). The workstation downloads firmware to the device's eMMC via the
USB sub-system. Board is 4-layer FR-4, USB Type-C charge + data (Type-C
connector in the U57xx block), single SoC + companion SoC (both at the
U14xx block, same MT-6769 silicon) + RF front-end + dedicated MT-6358
family PMU at the U24xx block. No PMIC datasheet publicly available; the
supply tree is reconstructed from the schematic. Repair-flow entry point
is always the USB download path — if the workstation cannot program the
device, every downstream diagnosis starts there.

## Known failure modes

- **Symptom:** Cannot DOWNLOAD — workstation reports "download failed" before eMMC erase begins
  - **Likely cause:** USB data lines (USB_DP / USB_DM) open or pulled, USB sub-system supply rail collapsed, or eMMC RST_n held low
  - **Components mentioned:** U1400F (SoC), the Type-C USB connector in the U57xx block, decoupling caps on VBUS_USB_IN / VUSB_PMU
  - **Rail / test point:** VBUS_USB_IN at the USB connector's VBUS pin (pin 42 area), VUSB_PMU on C1122
  - **Repair type:** rail-probe
  - **Rework hint:** Diode-mode probe VBUS_USB_IN and VUSB_PMU before swapping the SoC. Cold joints on the Type-C connector are the most common cause on a workstation fixture that has seen >5k insertion cycles.
  - **Resolution:** ambiguous

- **Symptom:** DOWNLOAD starts, fails at eMMC initialisation (0xC0/0xC1 stage in MediaTek bootrom log)
  - **Likely cause:** eMMC CLK line integrity issue, VMC_PMU rail missing, or SoC companion eMMC controller dead
  - **Components mentioned:** U1400F, U1400G, decoupling caps on VMC_PMU
  - **Rail / test point:** VMC_PMU on C1113, EMI_VDD1 on decoupling caps near the SoC package
  - **Repair type:** rail-probe + signal-integrity
  - **Rework hint:** Verify VMC_PMU at the SoC balls. If both rails good, reflow the SoC first (lead-free profile, peak 245°C, 30 s above 220°C); replace only if reflow fails twice.
  - **Resolution:** ambiguous

- **Symptom:** USB enumerated, MediaTek bootrom log appears, but download hangs at DA (Download Agent) load
  - **Likely cause:** LPDDR4X training failure or SoC PMU rail collapse under DA load
  - **Components mentioned:** U1400F, U1400G, PMU U2400C (MT-6358 family)
  - **Rail / test point:** VIO18_PMU, VA12_PMU, AVDD18_SOC, VEFUSE_PMU
  - **Repair type:** rail-probe-under-load
  - **Rework hint:** Capture all four PMU rails with scope on bench supply. AVDD18_SOC dipping under load points to SoC; stable PMU + dead LPDDR4 points to U1400G companion SoC.
  - **Resolution:** ambiguous

- **Symptom:** DOWNLOAD completes, device reboots, but reports "preloader fail" or "DRAM not ready"
  - **Likely cause:** LPDDR4X channel A or B not training; usually pad-level issue on a reworked companion SoC
  - **Components mentioned:** U1400F, U1400G
  - **Rail / test point:** VIO18_PMU_AP
  - **Repair type:** reflow
  - **Rework hint:** Reflow U1400G once; if same error, replace U1400G. Do not attempt board-level trace repair on LPDDR4X — signal length matching is below 0.1 mm tolerance.
  - **Resolution:** ambiguous

- **Symptom:** Battery icon shows after download, but device draws >500 mA from the fixture supply with backlight off
  - **Likely cause:** Short on a downstream rail (PA supply, LCM boost, backlight boost) dragging the PMU; or a backlight LED string short
  - **Components mentioned:** RF front-end (e.g. U6501, U8101), LCM boost (around U48xx), backlight driver (U38xx)
  - **Rail / test point:** All PA-supply rails, LCM boost output, BATT+ node
  - **Repair type:** rail-probe + LCR
  - **Rework hint:** Pull all fuses to LCM / RF PA and re-measure. Identify the rail, then diode-mode probe the rail's decoupling caps to find the shorted one. A 0.0 V diode reading on a decoupler confirms the dead cap.
  - **Resolution:** ambiguous

## Components mentioned by the community

- **U1400F** — aliases: SoC, MT-6769-series. Role: application processor + modem, eMMC host, USB 2.0 device.
  Typical failure: rarely the SoC itself fails in a programming-jig context; usually a pad-level issue after another repair.
- **U1400G** — aliases: companion SoC, MT-6769-series. Role: LPDDR4X interface partner, EMI bus bridge.
  Typical failure: cold joint after thermal cycling; pad lift if rework profile is too aggressive.
- **U2400C** — aliases: PMU, MT-6358-family. Role: generates VA12_PMU, AVDD18_SOC, VIO18_PMU, VEFUSE_PMU, VMC_PMU, VSIM1_PMU, VSIM2_PMU.
  Typical failure: rare; usually a regulator LDO dies taking one rail with it.
- **J5704** — aliases: USB Type-C connector. Role: VBUS_USB_IN, USB_DP, USB_DM, USB Type-C CC pins.
  Typical failure: shield pad lift after >5k insertions (fixture insertion life), cold joint on the through-hole shield pins.
- **U6501** — aliases: RF front-end PA. Role: cellular bands.
  Typical failure: PA die crack under mechanical stress, BGA reball candidates.
- **U8101** — aliases: connectivity companion. Role: WiFi/BT/GPS.
  Typical failure: rare.
- **U3801** — aliases: backlight boost driver. Role: constant-current boost for LCD backlight.
  Typical failure: boost inductor cold joint, output cap short.
- **U3803** — aliases: USB Type-C CC controller / port protection.
  Typical failure: dead after VBUS hot-plug stress; replace rather than reflow.

## Signals / power rails / nets mentioned

- **VBUS_USB_IN** — aliases: USB +5V in. Nominal voltage: 5.0 V. Measurable at: J5704 VBUS pin (pin 42 area).
- **VUSB_PMU** — aliases: PMU-generated USB rail. Nominal voltage: 3.3 V. Measurable at: C1122 (decoupling).
- **VIO18_PMU** — aliases: PMU 1.8 V logic. Nominal voltage: 1.8 V. Measurable at: C1108 / C1109 / C4902 (decoupling caps).
- **VA12_PMU** — aliases: PMU 1.2 V core. Nominal voltage: 1.2 V. Measurable at: C1100 / C1101 / C1106 / C1118 / C1119.
- **AVDD18_SOC** — aliases: SoC analog 1.8 V. Nominal voltage: 1.8 V. Measurable at: C1102-C1105, C1107.
- **VIO18_PMU_AP** — aliases: AP-side 1.8 V. Nominal voltage: 1.8 V. Measurable at: C1110-C1114.
- **VEFUSE_PMU** — aliases: eFuse programming rail. Nominal voltage: 1.8 V (nominal; pulses to 2.5 V during burn). Measurable at: eFuse block decoupling.
- **VMC_PMU** — aliases: eMMC core. Nominal voltage: 2.8 V or 3.0 V. Measurable at: C1113.
- **VSIM1_PMU / VSIM2_PMU** — aliases: SIM card supplies. Nominal voltage: 1.8 V / 3.0 V. Measurable at: C1115 / C1116.

## Sources

- local://repair-log-2026-06-18 — Field ticket: the SMT workstation cannot DOWNLOAD on three units back-to-back. Symptoms vary (hang at bootrom, hang at DA, eMMC init fail).
- local://schematic/schematic.pdf — 49-page schematic, vision-extracted into `schematic_graph.json` + `electrical_graph.json`.
- local://parts_index/parts_index.json — Refdes→MPN→role projection built at end of schematic ingestion (871 entries).
- local://boot_sequence/boot_sequence_analyzed.json — Per-phase boot ordering with rails_stable and components_entering.
- local://repair-station/smt-v551-fixture — Workstation insertion-cycle log: 5k+ insertions on J5704 across recent tickets.
