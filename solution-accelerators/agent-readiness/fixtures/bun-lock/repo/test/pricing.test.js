import { expect, test } from "bun:test";
import { discount, isAdult } from "../src/pricing.js";

test("isAdult is true from 18", () => {
  expect(isAdult(17)).toBe(false);
  expect(isAdult(18)).toBe(true);
});

test("discount takes 10 off from 100", () => {
  expect(discount(99)).toBe(99);
  expect(discount(100)).toBe(90);
});
