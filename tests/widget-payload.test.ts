import { describe, expect, it } from "vitest";

import { buildWidgetPayload } from "../src/lib/widget-payload.js";

const ACCOUNTING = {
  resultType: "quota",
  acquisitionMethod: "remote_api",
  ownership: "maintained",
  authority: "provider_reported",
} as const;

describe("buildWidgetPayload", () => {
  it("groups OpenCode Go windows in canonical 5h / Weekly / Monthly order", () => {
    const payload = buildWidgetPayload({
      nowMs: 1_700_000_000_000,
      data: {
        entries: [
          {
            name: "OpenCode Go 5h",
            group: "OpenCode Go",
            label: "5h:",
            percentRemaining: 88,
            resetTimeIso: "2026-08-12T12:30:00.000Z",
            accounting: ACCOUNTING,
          },
          {
            name: "OpenCode Go Weekly",
            group: "OpenCode Go",
            label: "Weekly:",
            percentRemaining: 55,
            resetTimeIso: "2026-08-16T16:00:00.000Z",
            accounting: ACCOUNTING,
          },
          {
            name: "OpenCode Go Monthly",
            group: "OpenCode Go",
            label: "Monthly:",
            percentRemaining: 20,
            accounting: ACCOUNTING,
          },
        ],
        errors: [],
      },
    });

    expect(payload.version).toBe(1);
    expect(payload.generatedAt).toBe(1_700_000_000_000);
    expect(payload.providers).toHaveLength(1);
    expect(payload.providers[0]?.name).toBe("OpenCode Go");
    expect(payload.providers[0]?.windows).toEqual([
      { label: "5h", percentRemaining: 88, resetAt: 1786537800 },
      { label: "Weekly", percentRemaining: 55, resetAt: 1786896000 },
      { label: "Monthly", percentRemaining: 20 },
    ]);
  });

  it("derives the provider from bracketed names and keeps first-seen order", () => {
    const payload = buildWidgetPayload({
      data: {
        entries: [
          { name: "[OpenAI] Weekly", percentRemaining: 50, accounting: ACCOUNTING },
          { name: "[OpenAI] Daily", percentRemaining: 70, accounting: ACCOUNTING },
          { name: "[Anthropic] 5h", percentRemaining: 30, accounting: ACCOUNTING },
        ],
        errors: [],
      },
    });

    expect(payload.providers.map((provider) => provider.name)).toEqual(["OpenAI", "Anthropic"]);
    expect(payload.providers[0]?.windows.map((window) => window.label)).toEqual([
      "Weekly",
      "Daily",
    ]);
  });

  it("ignores non-percent entries and caps the provider count", () => {
    const payload = buildWidgetPayload({
      maxProviders: 1,
      data: {
        entries: [
          { name: "[OpenAI] Balance", kind: "value", value: "$4.20", accounting: ACCOUNTING },
          { name: "[OpenAI] Weekly", percentRemaining: 50, accounting: ACCOUNTING },
          { name: "[Anthropic] 5h", percentRemaining: 30, accounting: ACCOUNTING },
        ],
        errors: [],
      },
    });

    expect(payload.providers).toHaveLength(1);
    expect(payload.providers[0]?.name).toBe("OpenAI");
    expect(payload.providers[0]?.windows).toHaveLength(1);
  });

  it("tags every provider block with the canonical id when one provider is targeted", () => {
    const payload = buildWidgetPayload({
      providerId: "opencode-go",
      data: {
        entries: [
          {
            name: "OpenCode Go 5h",
            group: "OpenCode Go",
            label: "5h:",
            percentRemaining: 90,
            accounting: ACCOUNTING,
          },
          {
            name: "OpenCode Go Weekly",
            group: "OpenCode Go",
            label: "Weekly:",
            percentRemaining: 80,
            accounting: ACCOUNTING,
          },
        ],
        errors: [],
      },
    });

    expect(payload.providers).toHaveLength(1);
    expect(payload.providers[0]?.id).toBe("opencode-go");
  });

  it("returns an empty provider list when there is no data", () => {
    expect(buildWidgetPayload({ data: null }).providers).toEqual([]);
    expect(buildWidgetPayload({ data: undefined }).providers).toEqual([]);
  });
});
