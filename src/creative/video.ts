/**
 * Video is part of the architecture, not of this release. This file only DECLARES what a video provider would have to say about itself, so the rest of the
 * app can be written against capabilities, and lists the video features honestly as not built. No video is generated, no storyboard job exists yet, and the
 * database does not yet allow a video creative (the creatives table accepts only static images).
 *
 * The plan (Master PRD Phase 4): a mock storyboard/video job is added only after the image flow is stable, using the same persisted-job, validate-then-store,
 * QA and approval path as images. Nothing below is wired to a route.
 */
export interface VideoProviderCapabilities {
  id: string;
  label: string;
  mock: boolean;
  offline: boolean;
  ratios: readonly string[];
  maxSeconds: number;
  formats: readonly string[];
  rendersAudio: boolean;
  /** Whether the provider can return a storyboard (frames and captions) instead of, or before, a rendered clip. */
  storyboard: boolean;
}

export const VIDEO_SUPPORT = {
  status: "not_built" as const,
  providers: [] as VideoProviderCapabilities[],
  note: "Video and storyboards are planned. Only still images can be made today.",
};
