// "Check now" (owner, 2026-11-06): "sometimes I'm watching the chat wait for a CI or review verdict when I can see it's already done in github. Would
// like a way to interrupt the check timer and force a check immediately."
//
// An agent that waits for CI does it inside its own shell call, which the extension cannot reach into. So the button sends a message the agent is told to
// obey, and the run's guidance tells it to wait in short polls rather than one long sleep, which is what makes the message land quickly. Pure: no I/O.
import { SCRATCH_DIR } from './scratch';

/** The marker a "Check now" message carries, so the agent can tell it apart from ordinary direction. */
export const CHECK_NOW_MARKER = 'CHECK-NOW';

/**
 * The message a "Check now" button sends. It is a Steer, so it interrupts the wait, and it is worded so the agent knows exactly what is wanted: look at
 * GitHub again now and carry on from what it finds.
 */
export function checkNowMessage(): string {
  return `[${CHECK_NOW_MARKER}] Check the real state now instead of waiting: read the pull request's checks and review verdict from GitHub again, and carry on from what they say. Do not sleep or wait again for this same verdict; if it is not there yet, poll again in short steps.`;
}

/** Whether a message is a "Check now" one. */
export function isCheckNow(text: string): boolean {
  return text.trimStart().startsWith(`[${CHECK_NOW_MARKER}]`);
}

/**
 * How a run is told to wait for something outside it (CI, a review, a deployment): in short polls, never one long sleep, so a person can interrupt it and
 * a verdict that lands early is picked up at once.
 */
export const WAITING_INSTRUCTIONS = `# Waiting for something outside the run
When you must wait for CI, a review verdict, a deployment or another person, never sleep for minutes in one command. Poll in short steps (no more than about 20 seconds each), check the real state from GitHub with \`gh\` each time, and stop the moment the answer is there. Slow enough to be cheap, short enough to interrupt: a person watching can press **Check now** (which interrupts the wait) or **Steer**, and either arrives at your next step rather than after a long sleep. Write any temporary poll output in \`${SCRATCH_DIR}/\`.`;
