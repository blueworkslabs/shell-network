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
  followup?: { number: number; jobs: StandingJob[] };
}

export function handoffInput(conversationKey: string, handoff: ScheduleHandoff) {
  return {
    clientRequestId: `bridge-${conversationKey}-schedule-handoff-${handoff.resetId}${handoff.followup ? `-${handoff.followup.number}` : ""}`,
    message: [
      handoff.followup
        ? "[Additional standing jobs were found while the previous session was draining.]"
        : "[Fresh session: read today's and yesterday's daily notes for continuity. The previous session is still draining.]",
      "Move each standing job below to this thread with schedule_task({ scheduledTaskId, bindToCurrentThread: true }).",
      "Pass only those two arguments. Preserve the schedule and enabled state. Do not run, recreate, or delete any job.",
      JSON.stringify((handoff.followup?.jobs ?? handoff.jobs).map((job) => job.scheduledTaskId)),
      "When finished, reply with exactly NO_REPLY.",
    ].join("\n"),
  };
}
