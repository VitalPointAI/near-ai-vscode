export type MotionState = 'idle' | 'reasoning' | 'streaming' | 'waiting' | 'complete' | 'failure';

export interface MotionPresentation {
  label: string;
  detail: string;
  live: 'polite' | 'assertive' | 'off';
}

export function motionPresentation(state: MotionState): MotionPresentation {
  switch (state) {
    case 'reasoning': return { label: 'Reasoning', detail: 'Preparing a response.', live: 'polite' };
    case 'streaming': return { label: 'Streaming', detail: 'Receiving the response.', live: 'polite' };
    case 'waiting': return { label: 'Waiting', detail: 'Waiting for approval or the next safe step.', live: 'polite' };
    case 'complete': return { label: 'Complete', detail: 'Response complete. Choose a next step.', live: 'polite' };
    case 'failure': return { label: 'Needs attention', detail: 'The response failed. Review the recovery action.', live: 'assertive' };
    default: return { label: 'Ready', detail: 'Ready for your next message.', live: 'off' };
  }
}
