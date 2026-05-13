import { describe, expect, test } from "bun:test";
import { parseCorrection, parseTime } from "../bin/override.ts";

describe("parseTime", () => {
  test("plain seconds", () => {
    expect(parseTime("42")).toBe(42);
    expect(parseTime("0")).toBe(0);
  });
  test("decimal seconds", () => {
    expect(parseTime("42.5")).toBe(42.5);
  });
  test("min:sec", () => {
    expect(parseTime("0:42")).toBe(42);
    expect(parseTime("1:15")).toBe(75);
    expect(parseTime("2:00")).toBe(120);
  });
  test("min:sec.ms", () => {
    expect(parseTime("1:15.5")).toBe(75.5);
  });
  test("rejects garbage", () => {
    expect(parseTime("abc")).toBeNull();
    expect(parseTime("")).toBeNull();
    expect(parseTime("1::2")).toBeNull();
  });
});

describe("parseCorrection", () => {
  test("add main drop (default)", () => {
    expect(parseCorrection("drop at 0:42")).toEqual({
      action: "add",
      kind: "main_drop",
      time: 42,
    });
  });
  test("add main drop explicit", () => {
    expect(parseCorrection("main drop at 0:42")).toEqual({
      action: "add",
      kind: "main_drop",
      time: 42,
    });
  });
  test("add secondary drop", () => {
    expect(parseCorrection("secondary drop at 1:15")).toEqual({
      action: "add",
      kind: "secondary_drop",
      time: 75,
    });
  });
  test("add beat", () => {
    expect(parseCorrection("beat at 0:32.5")).toEqual({
      action: "add",
      kind: "beat",
      time: 32.5,
    });
  });
  test("remove drop", () => {
    expect(parseCorrection("remove drop at 0:42")).toEqual({
      action: "remove",
      kind: "drop",
      time: 42,
    });
  });
  test("remove beat", () => {
    expect(parseCorrection("remove beat at 1:15")).toEqual({
      action: "remove",
      kind: "beat",
      time: 75,
    });
  });
  test("case insensitive", () => {
    expect(parseCorrection("DROP AT 0:42")).toEqual({
      action: "add",
      kind: "main_drop",
      time: 42,
    });
  });
  test("rejects unsupported phrasing", () => {
    expect(parseCorrection("make it groovier")).toBeNull();
    expect(parseCorrection("drop near the chorus")).toBeNull();
    expect(parseCorrection("")).toBeNull();
  });
});
