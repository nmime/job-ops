import { describe, expect, it } from "vitest";
import {
  EXTRACTOR_SOURCE_IDS,
  EXTRACTOR_SOURCE_METADATA,
  extractorSourceEnum,
  isExtractorSourceId,
} from "./index";

describe("extractor source catalog", () => {
  it("validates known source ids", () => {
    for (const source of EXTRACTOR_SOURCE_IDS) {
      expect(extractorSourceEnum.parse(source)).toBe(source);
      expect(isExtractorSourceId(source)).toBe(true);
    }
  });

  it("rejects unknown source ids", () => {
    expect(isExtractorSourceId("unknown-source")).toBe(false);
    expect(() => extractorSourceEnum.parse("unknown-source")).toThrow();
  });

  it("provides metadata for every known source", () => {
    for (const source of EXTRACTOR_SOURCE_IDS) {
      expect(EXTRACTOR_SOURCE_METADATA[source]).toBeDefined();
      expect(EXTRACTOR_SOURCE_METADATA[source].label.length).toBeGreaterThan(0);
    }
  });

  it("includes public API and Telegram sources as pipeline sources", () => {
    for (const source of [
      "greenhouse",
      "lever",
      "ashby",
      "smartrecruiters",
      "telegram",
      "himalayas",
      "hnhiring",
      "usajobs",
    ] as const) {
      expect(isExtractorSourceId(source)).toBe(true);
      expect(EXTRACTOR_SOURCE_METADATA[source]).toMatchObject({
        category: "pipeline",
      });
    }
  });

  it("marks USAJOBS as credential-backed", () => {
    expect(EXTRACTOR_SOURCE_METADATA.usajobs).toMatchObject({
      label: "USAJOBS",
      category: "pipeline",
      requiresCredentials: true,
    });
  });

  it("includes naukri as a pipeline source", () => {
    expect(isExtractorSourceId("naukri")).toBe(true);
    expect(EXTRACTOR_SOURCE_METADATA.naukri).toMatchObject({
      label: "Naukri",
      category: "pipeline",
    });
  });

  it("includes Ever Jobs as a pipeline source", () => {
    expect(isExtractorSourceId("everjobs")).toBe(true);
    expect(EXTRACTOR_SOURCE_METADATA.everjobs).toMatchObject({
      label: "Ever Jobs",
      category: "pipeline",
    });
  });
});
