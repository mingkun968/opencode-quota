import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { QUOTA_PROVIDER_LABELS } from "../src/lib/provider-metadata.js";

function read(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

function normalize(value: string): string {
  return value
    .replace(/（/g, "(")
    .replace(/）/g, ")")
    .replace(/[\s\u00a0]+/g, "")
    .toLowerCase();
}

const PROVIDER_LABELS = [...new Set(Object.values(QUOTA_PROVIDER_LABELS))].filter(
  (label) => label !== "Quota providers",
);

describe("README provider ledger", () => {
  const readme = read("README.md");
  const providerGuide = read("docs/readme/providers.md");

  it("lists every registered provider in the README and the provider guide", () => {
    const readmeText = normalize(readme);
    const guideText = normalize(providerGuide);

    for (const label of PROVIDER_LABELS) {
      expect(readmeText, `README is missing ${label}`).toContain(normalize(label));
      expect(guideText, `provider guide is missing ${label}`).toContain(normalize(label));
    }
  });

  it("keeps the localized README provider structure and custom-provider entry point", () => {
    expect(readme).toContain("## 支持的套餐");
    expect(readme).toContain("## 自定义套餐");
    expect(readme).toContain("opencode-quota provider add");
  });

  it("keeps the provider guide ledger structure", () => {
    expect(providerGuide).toMatch(/^#{2,3} Custom providers$/m);
    expect(providerGuide).toContain("npx @slkiser/opencode-quota@latest provider add");
  });
});
