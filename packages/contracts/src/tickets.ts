export type TicketStatus = 'PENDING' | 'WON' | 'LOST' | 'REFUNDED' | 'PARTIAL_RETURN';
export interface TicketRequest {
  stakeMinor: number; // hundredths of fictitious points, never money
  selections: { eventId: string; marketId: string; selectionId: string; expectedOdds: number }[];
  channel?: 'web' | 'posnet_test';
  terminalId?: string;
}
export interface TicketLeg {
  eventId: string; marketId: string; selectionId: string;
  eventName: string; marketName: string; selectionName: string;
  acceptedOdds: number; oddsMicros: number;
  settlement: number | null; resultDescription: string;
}
export interface TestTicket {
  id: string; mode: 'demo' | 'connected'; testOnly: true;
  createdAt: string; stakeMinor: number; currency: 'TEST_POINTS';
  status: TicketStatus; payoutMinor: number | null; revision: number;
  channel: 'web' | 'posnet_test'; terminalId?: string;
  selections: TicketLeg[];
  history: { revision: number; at: string; status: TicketStatus; payoutMinor: number | null; reason: string }[];
}
export interface TicketOutcome { eventId: string; marketId: string; selectionId: string; settlement: number; updatedAt: string }
