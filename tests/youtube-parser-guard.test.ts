import { test, expect } from "bun:test";
import { isBenignParserWarning, handleParserError } from "../lib/youtube";

test("benign parser drift is silenced", () => {
  expect(isBenignParserWarning("class_not_found")).toBe(true);
  expect(isBenignParserWarning("class_changed")).toBe(true);
});

test("real parser errors stay loud", () => {
  for (const t of ["typecheck", "mutation_data_missing", "mutation_data_invalid", undefined, null, ""]) {
    expect(isBenignParserWarning(t)).toBe(false);
  }
});

test("installed handler suppresses benign types, warns on real ones", () => {
  const calls: string[] = [];
  handleParserError({ classname: "Clarification", error_type: "class_not_found" }, (m) => calls.push(m));
  handleParserError({ classname: "Foo", error_type: "class_changed" }, (m) => calls.push(m));
  expect(calls).toEqual([]);
  handleParserError({ classname: "Bar", error_type: "typecheck" }, (m) => calls.push(m));
  expect(calls).toEqual(["[youtubei.js][typecheck]: Bar"]);
});

test("importing the module installs the handler without throwing", async () => {
  const { Parser } = await import("youtubei.js");
  expect(typeof Parser.setParserErrorHandler).toBe("function");
});
