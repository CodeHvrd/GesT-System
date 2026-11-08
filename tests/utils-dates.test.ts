import { describe, it, expect } from "vitest";
import {
  parseNumber,
  parsePercent,
  parseIntSafe,
  money,
  shortMoney,
  pct,
  pctPoints,
  safeDiv,
  norm,
  normKey,
  normProvider,
  plural,
} from "../src/lib/format";
import {
  parseDate,
  parseMonthKey,
  weekKey,
  weekBounds,
  weekIndex,
  prevWeek,
  nextWeek,
  prevMonth,
  nextMonth,
  sameWeekPrevMonth,
  weekLabel,
  monthLabel,
  resolveDateRange,
  previousRange,
  localDateFromUtc,
} from "../src/lib/dates";

describe("Format & Parsing Utilities (src/lib/format.ts)", () => {
  it("parses Argentine numbers, currencies, negatives, and decimals accurately", () => {
    expect(parseNumber("$ 1.234.567,89")).toBeCloseTo(1234567.89, 2);
    expect(parseNumber("15.000")).toBe(15000);
    expect(parseNumber("1.234,5")).toBeCloseTo(1234.5, 2);
    expect(parseNumber("(4.500,50)")).toBeCloseTo(-4500.5, 2);
    expect(parseNumber("-2500")).toBe(-2500);
    expect(parseNumber("1,234,567.89")).toBeCloseTo(1234567.89, 2);
    expect(parseNumber("")).toBe(0);
    expect(parseNumber(null)).toBe(0);
  });

  it("parses percentages in 0..1 and 0..100 formats", () => {
    expect(parsePercent("35%")).toBeCloseTo(0.35, 4);
    expect(parsePercent("35,5 %")).toBeCloseTo(0.355, 4);
    expect(parsePercent(0.28)).toBeCloseTo(0.28, 4);
    expect(parsePercent(42)).toBeCloseTo(0.42, 4);
  });

  it("formats money, shortMoney, pct, pctPoints, and plurals", () => {
    expect(money(15000)).toBe("$15.000");
    expect(money(-2500)).toBe("-$2.500");
    expect(shortMoney(1500000)).toBe("$1.5M");
    expect(shortMoney(45000)).toBe("$45k");
    expect(pct(0.352)).toBe("35,2%");
    expect(pctPoints(0.035)).toBe("+3,5 pp");
    expect(plural(1, "día", "días")).toBe("día");
    expect(plural(4, "día", "días")).toBe("días");
    expect(safeDiv(100, 0)).toBe(0);
    expect(parseIntSafe("42,8")).toBe(43);
  });

  it("normalizes strings, keys, and provider names (stripping SRL/SA suffixes)", () => {
    expect(norm("  Hola   Mundo  ")).toBe("Hola Mundo");
    expect(normKey("Cafetería & Pastelería!")).toBe("cafeteria y pasteleria");
    expect(normProvider("Distribuidora Sur S.R.L.")).toBe("distribuidora sur");
    expect(normProvider("Lácteos del Valle S.A.")).toBe("lacteos del valle");
  });
});

describe("Date & Fixed 5-Week Calendar Utilities (src/lib/dates.ts)", () => {
  it("parses ISO, DD/MM/YYYY, DD/MM/YY, and Excel serial dates", () => {
    expect(parseDate("2026-04-15")).toBe("2026-04-15");
    expect(parseDate("15/04/2026")).toBe("2026-04-15");
    expect(parseDate("5/4/26")).toBe("2026-04-05");
    expect(parseDate(45762)).toMatch(/^2025-04-/);
    expect(parseDate("invalid")).toBe("");
  });

  it("converts UTC timestamps to Argentina local date (UTC-3)", () => {
    // 01:30 UTC on April 10 is 22:30 on April 9 in Argentina
    expect(localDateFromUtc("2026-04-10T01:30:00Z")).toBe("2026-04-09");
    expect(localDateFromUtc("2026-04-10T15:00:00Z")).toBe("2026-04-10");
  });

  it("parses month keys including Spanish names and 5-digit year typos", () => {
    expect(parseMonthKey("2026-04")).toBe("2026-04");
    expect(parseMonthKey("20226-10")).toBe("2026-10");
    expect(parseMonthKey("Abril 2026")).toBe("2026-04");
    expect(parseMonthKey("Octubre", "2025-10-12")).toBe("2025-10");
  });

  it("assigns S1..S5 fixed week keys and computes exact bounds", () => {
    expect(weekKey("2026-04-01")).toBe("2026-04-S1");
    expect(weekKey("2026-04-07")).toBe("2026-04-S1");
    expect(weekKey("2026-04-08")).toBe("2026-04-S2");
    expect(weekKey("2026-04-15")).toBe("2026-04-S3");
    expect(weekKey("2026-04-22")).toBe("2026-04-S4");
    expect(weekKey("2026-04-29")).toBe("2026-04-S5");

    expect(weekBounds("2026-04-S1")).toEqual(["2026-04-01", "2026-04-07"]);
    expect(weekBounds("2026-04-S5")).toEqual(["2026-04-29", "2026-04-30"]);
    expect(weekBounds("2024-02-S5")).toEqual(["2024-02-29", "2024-02-29"]);
    expect(weekIndex("2026-04-S3")).toBe(3);
  });

  it("navigates weeks and months accurately", () => {
    expect(prevWeek("2026-04-S1")).toBe("2026-03-S5");
    expect(prevWeek("2026-04-S3")).toBe("2026-04-S2");
    expect(nextWeek("2026-04-S5")).toBe("2026-05-S1");
    expect(prevMonth("2026-01")).toBe("2025-12");
    expect(nextMonth("2025-12")).toBe("2026-01");
    expect(sameWeekPrevMonth("2026-04-S2")).toBe("2026-03-S2");
    expect(weekLabel("2026-04-S2")).toContain("Semana 2");
    expect(monthLabel("2026-04")).toBe("Abril 2026");
  });

  it("resolves presets and previous comparison date ranges", () => {
    const [dFrom, dTo] = resolveDateRange(null, "2026-04-01", "2026-04-07");
    expect(dFrom).toBe("2026-04-01");
    expect(dTo).toBe("2026-04-07");
    const [pFrom, pTo] = previousRange(dFrom, dTo);
    expect(pFrom).toBe("2026-03-25");
    expect(pTo).toBe("2026-03-31");
  });
});

