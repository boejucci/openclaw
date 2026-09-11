import { describe, expect, it } from "vitest";
import { classifyExecCommand } from "./exec-classifier.js";

describe("classifyExecCommand — pure-sf", () => {
  it("bare sf → pure-sf", () => {
    expect(classifyExecCommand("sf")).toBe("pure-sf");
  });

  it("sf with flags → pure-sf", () => {
    expect(classifyExecCommand("sf data query -q 'SELECT Id FROM Account'")).toBe("pure-sf");
  });

  it("sf with --json flag → pure-sf", () => {
    expect(classifyExecCommand("sf org list metadata --json")).toBe("pure-sf");
  });

  it("env-prefix before sf → pure-sf", () => {
    expect(classifyExecCommand("SF_LOG_LEVEL=debug sf data query -q x")).toBe("pure-sf");
  });

  it("absolute path whose basename is sf → pure-sf", () => {
    expect(classifyExecCommand("/usr/local/bin/sf project deploy start")).toBe("pure-sf");
  });

  it("wrapper words before sf → pure-sf", () => {
    expect(classifyExecCommand("env SF_LOG=1 sf org list metadata")).toBe("pure-sf");
  });

  it("two sf commands chained with ; → pure-sf", () => {
    expect(classifyExecCommand("sf help; sf data query -q x")).toBe("pure-sf");
  });

  it("two sf commands chained with && → pure-sf", () => {
    expect(classifyExecCommand("sf project retrieve start && sf apex run --file x.apex")).toBe(
      "pure-sf",
    );
  });

  it("three sf commands chained with ; and && → pure-sf", () => {
    expect(classifyExecCommand("sf help; sf data query -q x && sf apex list log")).toBe("pure-sf");
  });

  it("lone & (background operator) → generic (SF-ES-1)", () => {
    expect(classifyExecCommand("sf data query -q x &")).toBe("generic");
  });

  it("& inside quotes → pure-sf", () => {
    expect(classifyExecCommand("sf data query -q 'A & B Corp'")).toBe("pure-sf");
  });

  it("sf with a query argument containing > (inside quotes) → pure-sf", () => {
    // The > is inside a quoted string — not a real redirection
    expect(classifyExecCommand("sf data query -q 'SELECT Id FROM Account WHERE Amount > 0'")).toBe(
      "pure-sf",
    );
  });

  it("sf with a query argument containing < (inside quotes) → pure-sf", () => {
    expect(
      classifyExecCommand('sf data query -q "SELECT Id FROM Account WHERE CreatedDate < TODAY"'),
    ).toBe("pure-sf");
  });
});

describe("classifyExecCommand — generic (non-sf invocation)", () => {
  it("rm -rf → generic", () => {
    expect(classifyExecCommand("rm -rf /tmp/x")).toBe("generic");
  });

  it("echo hello → generic", () => {
    expect(classifyExecCommand("echo hello")).toBe("generic");
  });

  it("sf; rm -rf → generic (rm is non-sf)", () => {
    expect(classifyExecCommand("sf help; rm -rf /tmp/x")).toBe("generic");
  });

  it("cd /work && sf data query → generic (cd is non-sf)", () => {
    expect(classifyExecCommand("cd /work && sf data query -q 'SELECT Id FROM Account'")).toBe(
      "generic",
    );
  });

  it("cat /etc/passwd → generic", () => {
    expect(classifyExecCommand("cat /etc/passwd")).toBe("generic");
  });

  it("python script.py → generic", () => {
    expect(classifyExecCommand("python script.py")).toBe("generic");
  });

  it("sfdx → generic (not sf)", () => {
    expect(classifyExecCommand("sfdx force:org:display")).toBe("generic");
  });
});

describe("classifyExecCommand — generic (pipe)", () => {
  it("sf … | head → generic (pipe present)", () => {
    expect(classifyExecCommand("sf org list metadata | head")).toBe("generic");
  });

  it("sf … || sf … → generic (|| is a pipe character)", () => {
    expect(classifyExecCommand("sf help || sf data query -q x")).toBe("generic");
  });

  it("echo foo | sf → generic even if sf follows the pipe", () => {
    expect(classifyExecCommand("echo foo | sf data query -q x")).toBe("generic");
  });
});

describe("classifyExecCommand — generic (redirection)", () => {
  it("sf … > /tmp/out → generic (output redirection)", () => {
    expect(classifyExecCommand("sf org list metadata > /tmp/out.json")).toBe("generic");
  });

  it("sf … >> /tmp/out → generic (append redirection)", () => {
    expect(classifyExecCommand("sf apex get log >> /tmp/log.txt")).toBe("generic");
  });

  it("sf … < input.json → generic (input redirection)", () => {
    expect(classifyExecCommand("sf data import < input.json")).toBe("generic");
  });

  it("sf > /etc/x → generic", () => {
    expect(classifyExecCommand("sf > /etc/x")).toBe("generic");
  });
});

describe("classifyExecCommand — generic (command substitution / subshell)", () => {
  it("sf$(evil) → generic ($ in invocation token)", () => {
    expect(classifyExecCommand("sf$(evil) data query")).toBe("generic");
  });

  it("$(sf data query) → generic (command substitution)", () => {
    expect(classifyExecCommand("$(sf data query -q x)")).toBe("generic");
  });

  it("backtick command substitution → generic", () => {
    expect(classifyExecCommand("`sf data query -q x`")).toBe("generic");
  });

  it("subshell with ( ) → generic", () => {
    expect(classifyExecCommand("(sf data query -q x)")).toBe("generic");
  });

  it("sf `evil` → generic (backtick in command)", () => {
    expect(classifyExecCommand("sf `evil`")).toBe("generic");
  });
});

describe("classifyExecCommand — edge cases", () => {
  it("empty string → generic", () => {
    expect(classifyExecCommand("")).toBe("generic");
  });

  it("whitespace-only string → generic", () => {
    expect(classifyExecCommand("   \t  ")).toBe("generic");
  });

  it("only env assignments, no invocation → generic", () => {
    expect(classifyExecCommand("SF_LOG=1")).toBe("generic");
  });

  it("only wrapper word, no invocation → generic", () => {
    expect(classifyExecCommand("env")).toBe("generic");
  });

  it("SF_LOG=1 sf org list metadata → pure-sf (env-prefix stripped)", () => {
    expect(classifyExecCommand("SF_LOG=1 sf org list metadata")).toBe("pure-sf");
  });

  it("newline-separated sf commands → pure-sf", () => {
    expect(classifyExecCommand("sf help\nsf data query -q x")).toBe("pure-sf");
  });

  it("segments separated by ; with trailing spaces → pure-sf", () => {
    expect(classifyExecCommand("sf help ;  sf data query -q x")).toBe("pure-sf");
  });
});
