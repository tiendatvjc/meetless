import type { TranscriptionPremiumAccess } from "./transcription-route.js";

/**
 * Linux has no RevenueCat SDK. Premium is permanently inactive here; managed
 * transcription must go through a macOS host or a self-hosted Convex deploy,
 * while BYOK transcription stays free per docs/product/monetization.md.
 */
export class LinuxNoopPremiumAccess implements TranscriptionPremiumAccess {
  async status(): Promise<{ status: "inactive"; reason: "linux-noop" }> {
    return { status: "inactive", reason: "linux-noop" };
  }

  async purchase(): Promise<never> {
    throw new Error("Linux không hỗ trợ RevenueCat Premium. Dùng BYOK OpenAI key (byok-openai.json) hoặc macOS host cho managed transcription.");
  }

  async restore(): Promise<never> {
    throw new Error("Linux không hỗ trợ RevenueCat Premium. Dùng BYOK OpenAI key (byok-openai.json) hoặc macOS host cho managed transcription.");
  }
}
