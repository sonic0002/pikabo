import { assertionSteps } from './assertions.js';
import { interactionSteps } from './interaction.js';
import { navigationSteps } from './navigation.js';
import { optionalBoolean, optionalString, requireString, type StepHandler } from './types.js';

const captureSteps: Record<string, StepHandler> = {
  async screenshot(ctx) {
    const name = optionalString(ctx, 'name') ?? 'screenshot';
    const path = await ctx.capture(name, {
      fullPage: optionalBoolean(ctx, 'fullPage'),
      selector: optionalString(ctx, 'selector'),
    });
    return path;
  },

  async note(ctx) {
    ctx.note(requireString(ctx, 'text'));
    return undefined;
  },
};

export const STEP_HANDLERS: Record<string, StepHandler> = {
  ...navigationSteps,
  ...interactionSteps,
  ...assertionSteps,
  ...captureSteps,
};

export { AssertionError } from './types.js';
export type { StepContext, StepHandler } from './types.js';
