/**
 * Outcome recorded for each driver notified about a ride, used for audit/RCA.
 */
export enum AssignmentLogStatus {
  NOTIFIED = 'NOTIFIED',
  ACCEPTED = 'ACCEPTED',
  REJECTED = 'REJECTED',
  TIMED_OUT = 'TIMED_OUT',
  LATE_ACCEPT_REJECTED = 'LATE_ACCEPT_REJECTED',
}
