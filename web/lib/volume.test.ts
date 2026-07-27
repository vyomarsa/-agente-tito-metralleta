import { describe, expect, it } from "vitest";
import { avg20dVolume } from "./volume";
import type { DailyBar } from "./types";

function bar(volume?: number): DailyBar {
  return { time: "2026-07-01", open: 1, high: 1, low: 1, close: 1, volume };
}

describe("avg20dVolume", () => {
  it("promedia las últimas 20 barras cuando hay más", () => {
    // 25 barras: 5 de valor 100 (más viejas) y 20 de valor 200 (más recientes).
    const bars = [...Array(5).fill(bar(100)), ...Array(20).fill(bar(200))];
    expect(avg20dVolume(bars)).toBe(200);
  });

  it("promedia todas si hay menos de 20", () => {
    expect(avg20dVolume([bar(100), bar(300)])).toBe(200);
  });

  it("ignora barras sin volumen", () => {
    expect(avg20dVolume([bar(100), bar(undefined), bar(300)])).toBe(200);
  });

  it("devuelve null si ninguna barra trae volumen", () => {
    expect(avg20dVolume([bar(undefined), bar(undefined)])).toBeNull();
  });

  it("devuelve null con lista vacía", () => {
    expect(avg20dVolume([])).toBeNull();
  });

  it("respeta un tamaño de ventana personalizado", () => {
    const bars = [bar(100), bar(100), bar(400)];
    expect(avg20dVolume(bars, 2)).toBe(250);
  });
});
