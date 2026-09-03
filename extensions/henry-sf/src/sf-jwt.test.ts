import { createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { mintSalesforceAccessToken } from "./sf-jwt.js";

const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

function decodeBase64UrlJson(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

describe("mintSalesforceAccessToken", () => {
  it("signs the JWT bearer assertion with the org's key and mints the access token", async () => {
    const nowMs = 1_700_000_000_000;
    const fetchImpl: typeof fetch = async (url, init) => {
      expect(url).toBe("https://isi.my.salesforce.com/services/oauth2/token");
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("content-type")).toBe(
        "application/x-www-form-urlencoded",
      );

      const requestBody = new URLSearchParams(init?.body as string);
      expect(requestBody.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
      const [headerPart, claimsPart, signaturePart] = (requestBody.get("assertion") ?? "").split(
        ".",
      );

      expect(decodeBase64UrlJson(headerPart)).toEqual({ alg: "RS256", typ: "JWT" });
      expect(decodeBase64UrlJson(claimsPart)).toEqual({
        iss: "consumer-key",
        sub: "person@isi.example",
        aud: "https://isi.my.salesforce.com",
        exp: Math.floor(nowMs / 1000) + 180,
      });

      const verifier = createVerify("RSA-SHA256");
      verifier.update(`${headerPart}.${claimsPart}`);
      verifier.end();
      expect(verifier.verify(publicKey, signaturePart, "base64url")).toBe(true);

      return new Response(
        JSON.stringify({
          access_token: "00D...!AQ",
          instance_url: "https://isi.my.salesforce.com",
        }),
        { status: 200 },
      );
    };

    const credential = await mintSalesforceAccessToken({
      loginUrl: "https://isi.my.salesforce.com",
      clientId: "consumer-key",
      username: "person@isi.example",
      privateKeyPem: privateKey,
      fetchImpl,
      now: () => nowMs,
    });

    expect(credential).toEqual({
      accessToken: "00D...!AQ",
      instanceUrl: "https://isi.my.salesforce.com",
      issuedAtMs: nowMs,
    });
  });

  it("rejects with the status and error fields, and never the assertion, on a Salesforce error", async () => {
    let capturedAssertion = "";
    const fetchImpl: typeof fetch = async (_url, init) => {
      capturedAssertion = new URLSearchParams(init?.body as string).get("assertion") ?? "";
      return new Response(
        JSON.stringify({
          error: "invalid_grant",
          error_description: "user hasn't approved this consumer",
        }),
        { status: 400 },
      );
    };

    let thrown: Error | undefined;
    try {
      await mintSalesforceAccessToken({
        loginUrl: "https://isi.my.salesforce.com",
        clientId: "consumer-key",
        username: "person@isi.example",
        privateKeyPem: privateKey,
        fetchImpl,
      });
    } catch (error) {
      thrown = error as Error;
    }

    expect(capturedAssertion.length).toBeGreaterThan(0);
    expect(thrown?.message).toContain("400");
    expect(thrown?.message).toContain("invalid_grant");
    expect(thrown?.message).not.toContain(capturedAssertion);
    expect(thrown?.message).not.toContain(privateKey);
  });

  it("rejects once the request exceeds the timeout", async () => {
    const hangingFetch: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("the request timed out")));
      });

    await expect(
      mintSalesforceAccessToken({
        loginUrl: "https://isi.my.salesforce.com",
        clientId: "consumer-key",
        username: "person@isi.example",
        privateKeyPem: privateKey,
        fetchImpl: hangingFetch,
        timeoutMs: 20,
      }),
    ).rejects.toThrow();
  });
});
