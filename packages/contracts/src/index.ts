export type Sport = 'futbol' | 'tenis' | 'basquet' | 'hipica';
export interface Selection { id: string; label: string; odds: number }
export interface SportEvent { id: string; sport: Sport; league: string; home: string; away: string; time: string; live: boolean; score?: string; market: string; selections: Selection[] }
export interface EventFeed { mode: 'demo'; notice: string; events: SportEvent[] }
export interface EventSource { getEvents(): Promise<EventFeed> }
