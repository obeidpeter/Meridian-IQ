import { test, expect, describe } from "vitest";
import {
  bandBadgeClasses,
  bandLabel,
  connectionBadgeClasses,
  enrollmentBadgeClasses,
  enrollmentLabel,
  importRowBadgeClasses,
  importRowLabel,
  messageBadgeClasses,
  messageStatusLabel,
  priorityBadgeClasses,
  railBadgeClasses,
  railStateLabel,
  riskBadgeClasses,
  riskLabel,
} from "./format";

// The shared formatters are tested once, in @workspace/format; this file
// covers only the console-specific badge vocabularies kept in ./format.ts.

describe("penalty risk", () => {
  test("labels and tones the three bands, defaulting unknowns to slate", () => {
    expect(riskLabel("high")).toBe("High risk");
    expect(riskBadgeClasses("high")).toContain("red");
    expect(riskBadgeClasses("medium")).toContain("amber");
    expect(riskBadgeClasses("low")).toContain("emerald");
    expect(riskBadgeClasses("weird")).toContain("slate");
  });
});

describe("case priority", () => {
  test("high is red, medium amber, everything else slate", () => {
    expect(priorityBadgeClasses("high")).toContain("red");
    expect(priorityBadgeClasses("medium")).toContain("amber");
    expect(priorityBadgeClasses("low")).toContain("slate");
  });
});

describe("CPD enrollment", () => {
  test("labels the two known statuses and humanizes the rest", () => {
    expect(enrollmentLabel("enrolled")).toBe("Enrolled");
    expect(enrollmentLabel("completed")).toBe("Completed");
    expect(enrollmentLabel("weird_state")).toBe("Weird state");
    expect(enrollmentBadgeClasses("completed")).toContain("emerald");
    expect(enrollmentBadgeClasses("enrolled")).toContain("amber");
    expect(enrollmentBadgeClasses("weird")).toContain("slate");
  });
});

describe("message deliveries", () => {
  test("tones delivered/failed/sent and humanizes labels", () => {
    expect(messageStatusLabel("delivered")).toBe("Delivered");
    expect(messageBadgeClasses("delivered")).toContain("emerald");
    expect(messageBadgeClasses("failed")).toContain("red");
    expect(messageBadgeClasses("sent")).toContain("blue");
    expect(messageBadgeClasses("queued")).toContain("slate");
  });
});

describe("rail circuit breaker", () => {
  test("labels the three breaker states and humanizes the rest", () => {
    expect(railStateLabel("open")).toBe("Circuit open");
    expect(railStateLabel("half_open")).toBe("Half-open (probing)");
    expect(railStateLabel("closed")).toBe("Healthy");
    expect(railStateLabel("weird_state")).toBe("Weird state");
    expect(railBadgeClasses("open")).toContain("red");
    expect(railBadgeClasses("half_open")).toContain("amber");
    expect(railBadgeClasses("closed")).toContain("emerald");
    expect(railBadgeClasses("weird")).toContain("slate");
  });
});

describe("ERP connections", () => {
  test("active is emerald, error red, everything else slate", () => {
    expect(connectionBadgeClasses("active")).toContain("emerald");
    expect(connectionBadgeClasses("error")).toContain("red");
    expect(connectionBadgeClasses("pending")).toContain("slate");
  });
});

describe("client import rows", () => {
  test("labels and tones the three row outcomes", () => {
    expect(importRowLabel("created")).toBe("Created");
    expect(importRowLabel("exists")).toBe("Already exists");
    expect(importRowLabel("invalid")).toBe("Invalid");
    expect(importRowLabel("weird_state")).toBe("Weird state");
    expect(importRowBadgeClasses("created")).toContain("emerald");
    expect(importRowBadgeClasses("exists")).toContain("amber");
    expect(importRowBadgeClasses("invalid")).toContain("red");
    expect(importRowBadgeClasses("weird")).toContain("slate");
  });
});

describe("assessment bands", () => {
  test("ready/partial tone up; anything else reads as a red not-ready band", () => {
    expect(bandLabel("ready")).toBe("Ready");
    expect(bandBadgeClasses("ready")).toContain("emerald");
    expect(bandBadgeClasses("partial")).toContain("amber");
    expect(bandBadgeClasses("not_ready")).toContain("red");
  });
});
