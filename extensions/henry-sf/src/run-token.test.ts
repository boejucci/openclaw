import { describe, expect, it } from "vitest";
import { createRunTokenIssuer } from "./run-token.js";

describe("createRunTokenIssuer", () => {
  it("round-trips issued claims through verify with the injected clock", () => {
    let currentMs = 1_700_000_000_000;
    const issuer = createRunTokenIssuer({ ttlSeconds: 900, now: () => currentMs });

    const token = issuer.issue({ runId: "run-1", senderId: "profile-ada" });

    expect(issuer.verify(token)).toEqual({
      runId: "run-1",
      senderId: "profile-ada",
      exp: currentMs + 900_000,
    });
  });

  it("rejects a tampered claims body or a tampered signature", () => {
    const issuer = createRunTokenIssuer({ ttlSeconds: 900, now: () => 0 });
    const token = issuer.issue({ runId: "run-1", senderId: "profile-ada" });
    const [version, claimsPart, signaturePart] = token.split(".");
    const flip = (segment: string) => (segment[0] === "a" ? "b" : "a") + segment.slice(1);

    expect(issuer.verify(`${version}.${flip(claimsPart)}.${signaturePart}`)).toBeNull();
    expect(issuer.verify(`${version}.${claimsPart}.${flip(signaturePart)}`)).toBeNull();
  });

  it("rejects a token issued by an issuer with a different secret", () => {
    const now = () => 0;
    const issuerA = createRunTokenIssuer({ ttlSeconds: 900, now, secret: Buffer.from("secret-a") });
    const issuerB = createRunTokenIssuer({ ttlSeconds: 900, now, secret: Buffer.from("secret-b") });

    const token = issuerA.issue({ runId: "run-1", senderId: "profile-ada" });

    expect(issuerB.verify(token)).toBeNull();
  });

  it("expires exactly at the TTL boundary, not one second before", () => {
    let currentMs = 0;
    const issuer = createRunTokenIssuer({ ttlSeconds: 900, now: () => currentMs });
    const token = issuer.issue({ runId: "run-1", senderId: "profile-ada" });

    currentMs = 900_000 - 1_000;
    expect(issuer.verify(token)).not.toBeNull();

    currentMs = 900_000;
    expect(issuer.verify(token)).toBeNull();
  });

  it("throws when issuing with an empty runId or senderId", () => {
    const issuer = createRunTokenIssuer({ ttlSeconds: 900 });

    expect(() => issuer.issue({ runId: "", senderId: "profile-ada" })).toThrow();
    expect(() => issuer.issue({ runId: "run-1", senderId: "" })).toThrow();
  });

  it.each([
    ["empty string", ""],
    ["two segments", "a.b"],
    ["empty claims segment", "hsf1..x"],
    ["wrong version", "hsf9.AAAA.BBBB"],
  ])("returns null instead of throwing for garbage input: %s", (_label, garbage) => {
    const issuer = createRunTokenIssuer({ ttlSeconds: 900 });
    expect(issuer.verify(garbage)).toBeNull();
  });
});
