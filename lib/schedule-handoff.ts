// The replacement may receive only this bridge-owned input until it becomes the bound thread.
export interface StandingJob {
  scheduledTaskId: string;
  enabled: boolean;
}

export interface ScheduleHandoff {
  resetId: string;
  oldThread: string;
  newTitle: string;
  replacement?: string;
  jobs: StandingJob[];
}

export function handoffInput(conversationKey: string, handoff: ScheduleHandoff) {
  return {
    clientRequestId: `bridge-${conversationKey}-schedule-handoff-${handoff.resetId}`,
    message: [
      "[Fresh session: read today's and yesterday's daily notes for continuity. The previous session is still draining.]",
      "Move each standing job below to this thread with schedule_task({ scheduledTaskId, bindToCurrentThread: true }).",
      "Pass only those two arguments. Preserve the schedule and enabled state. Do not run, recreate, or delete any job.",
      JSON.stringify(handoff.jobs.map((job) => job.scheduledTaskId)),
      "When finished, reply with exactly NO_REPLY.",
    ].join("\n"),
  };
}
