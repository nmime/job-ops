import { createAppSettings } from "@shared/testing/factories.js";
import { act, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import { renderHookWithQueryClient } from "../test/renderWithQueryClient";
import { _resetSettingsCache, useSettings } from "./useSettings";

vi.mock("../api", () => ({
  getSettings: vi.fn(),
  hasAuthenticatedSession: vi.fn(() => true),
}));

describe("useSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetSettingsCache();
  });

  it("fetches settings on mount if not already cached", async () => {
    const mockSettings = createAppSettings({
      showSponsorInfo: { value: false, default: true, override: false },
      renderMarkdownInJobDescriptions: {
        value: false,
        default: true,
        override: false,
      },
    });
    vi.mocked(api.getSettings).mockResolvedValue(mockSettings);

    const { result } = renderHookWithQueryClient(() => useSettings());

    // Should start in loading state
    expect(result.current.settings).toBeNull();

    await waitFor(() => {
      expect(result.current.settings).toEqual(mockSettings);
    });

    expect(result.current.showSponsorInfo).toBe(false);
    expect(result.current.renderMarkdownInJobDescriptions).toBe(false);
    expect(api.getSettings).toHaveBeenCalledTimes(1);
  });

  it("uses default values when settings are null", async () => {
    vi.mocked(api.getSettings).mockResolvedValue(null as any);

    const { result } = renderHookWithQueryClient(() => useSettings());

    await waitFor(() => {
      // settings is null, so showSponsorInfo should default to true
      expect(result.current.showSponsorInfo).toBe(true);
      expect(result.current.renderMarkdownInJobDescriptions).toBe(true);
    });
  });

  it("provides a refresh function that updates settings", async () => {
    const initialSettings = createAppSettings();
    const updatedSettings = createAppSettings({
      showSponsorInfo: { value: false, default: true, override: false },
      renderMarkdownInJobDescriptions: {
        value: false,
        default: true,
        override: false,
      },
    });

    vi.mocked(api.getSettings).mockResolvedValueOnce(initialSettings);
    vi.mocked(api.getSettings).mockResolvedValueOnce(updatedSettings);

    const { result } = renderHookWithQueryClient(() => useSettings());

    await waitFor(() => {
      expect(result.current.settings).toEqual(initialSettings);
    });

    let refreshed: any;
    await act(async () => {
      refreshed = await result.current.refreshSettings();
    });

    await waitFor(() => {
      expect(result.current.settings).toEqual(updatedSettings);
    });

    expect(refreshed).toEqual(updatedSettings);
    expect(result.current.showSponsorInfo).toBe(false);
    expect(result.current.renderMarkdownInJobDescriptions).toBe(false);
  });

  it("handles errors when fetching settings", async () => {
    const mockError = new Error("Failed to fetch");
    vi.mocked(api.getSettings).mockRejectedValue(mockError);

    const { result } = renderHookWithQueryClient(() => useSettings());

    await waitFor(() => {
      expect(result.current.error).toEqual(mockError);
    });

    expect(result.current.isLoading).toBe(false);
    expect(result.current.settings).toBeNull();
  });
});
