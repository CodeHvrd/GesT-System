import { describe, it, expect } from "vitest";
import {
  DEFAULT_CONFIG,
  sheetIdFromUrl,
  tabUrl,
  parseTargetsText,
  targetsText,
} from "../src/lib/config";

describe("Configuration & Google Sheets URL Helpers (src/lib/config.ts)", () => {
  it("extracts Google Sheet ID from full URLs or raw IDs", () => {
    const url =
      "https://docs.google.com/spreadsheets/d/1x5R937698574525c79j321/edit#gid=0";
    expect(sheetIdFromUrl(url)).toBe("1x5R937698574525c79j321");
    expect(sheetIdFromUrl("1x5R937698574525c79j321")).toBe(
      "1x5R937698574525c79j321"
    );
  });

  it("builds Google Sheets tab CSV export URL", () => {
    const u = tabUrl("SHEET123", "GASTOS");
    expect(u).toBe(
      "https://docs.google.com/spreadsheets/d/SHEET123/gviz/tq?tqx=out:csv&sheet=GASTOS"
    );
  });

  it("parses and formats category CMV targets text", () => {
    const text = "cafeteria = 28%\npasteleria: 38\nbebidas = 0.45";
    const parsed = parseTargetsText(text);
    expect(parsed.cafeteria).toBeCloseTo(0.28, 4);
    expect(parsed.pasteleria).toBeCloseTo(0.38, 4);
    expect(parsed.bebidas).toBeCloseTo(0.45, 4);

    const formatted = targetsText(parsed);
    expect(formatted).toContain("cafeteria = 28%");
    expect(formatted).toContain("pasteleria = 38%");
    expect(formatted).toContain("bebidas = 45%");
  });

  it("has valid default CMV targets and fixed expense categories", () => {
    expect(DEFAULT_CONFIG.cmv_objetivo_general).toBe(0.35);
    expect(DEFAULT_CONFIG.gastos_fijos_categorias).toContain("Alquiler");
    expect(DEFAULT_CONFIG.gastos_fijos_categorias).toContain("Sueldos");
  });
});

