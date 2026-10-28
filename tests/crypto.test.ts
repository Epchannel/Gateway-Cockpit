import { describe, it, expect } from "vitest";
import { passwordHash, passwordVerify, safeEqual } from "../src/crypto.js";
describe("crypto", () => {
  it("uses argon2id and verifies", () => {
    const x = passwordHash("long enough password");
    expect(x.startsWith("argon2id$")).toBe(true);
    expect(passwordVerify("long enough password", x)).toBe(true);
    expect(passwordVerify("wrong password", x)).toBe(false);
    expect(safeEqual("a", "aa")).toBe(false);
  });
});
