import { describe, expect, it } from "vitest";
import { DEMO_SOURCE_BASE_URLS } from "./demo-defaults.data";

describe("demo source base urls", () => {
  it("keeps actualized and upstream source base URLs", () => {
    expect(DEMO_SOURCE_BASE_URLS).toMatchObject({
      everjobs: "https://everjobs.example",
      fiveamsat: "https://khamsat.com",
      wazzuf: "https://wuzzuf.net",
    });
  });
});
