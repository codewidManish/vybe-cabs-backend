/**
 * Full lifecycle of a ride, from creation to completion or termination.
 */
export enum RideStatus {
  REQUESTED = 'REQUESTED',
  SEARCHING = 'SEARCHING',
  WAITING_FOR_ACCEPTANCE = 'WAITING_FOR_ACCEPTANCE',
  ASSIGNED = 'ASSIGNED',
  TIMEOUT = 'TIMEOUT',
  CANCELLED = 'CANCELLED',
  COMPLETED = 'COMPLETED',
}
