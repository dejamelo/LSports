import { marketStatusLabel, type SportEvent } from '@lsports/contracts';
const count = (values: string[]) => values.reduce<Record<string, number>>((out, key) => { out[key] = (out[key] || 0) + 1; return out; }, {});
const statusKey = (n?: number) => n === undefined ? 'missing' : String(n);
const priceValid = (s: { odds: number }) => Number.isFinite(s.odds) && s.odds > 1;
const flag = (value?: boolean) => value === undefined ? 'missing' : String(value);
/** Explain the existing candidate decision; never change or reapply its rules. */
export function explainOpenEventExclusions(events: SportEvent[], candidateIds: Set<string>) {
  const excluded = events.filter(event => !candidateIds.has(event.id)).map(event => {
    const identity = { eventId: event.id, fixtureId: Number(event.id.split(':').at(-1)), competitionId: event.competition?.id, source: event.source };
    const reasons = new Set<string>();
    if (![1, 2, 9].includes(event.status ?? 0)) reasons.add(event.status === undefined ? 'fixture_status_missing' : 'fixture_not_active');
    if (event.available !== true) reasons.add(event.available === undefined ? 'event_availability_missing' : 'event_not_available');
    const markets = (event.markets || []).map(market => {
      const selections = market.selections;
      const priced = selections.filter(priceValid);
      const selectable = selections.filter(s => s.available === true && priceValid(s));
      const blocked = selections.filter(s => s.available !== true);
      const selectionReasons = count(blocked.flatMap(s => s.unavailableReasons?.length ? s.unavailableReasons : ['not_reported_by_projection']));
      const inconsistencies = selections.flatMap(s => {
        if (s.available !== true) return [];
        return [
          ...(s.unavailableReasons?.length ? [{ reason: 'available_with_blocking_reasons', selectionId: s.id }] : []),
          ...(market.status !== 1 ? [{ reason: 'available_on_non_open_market', selectionId: s.id }] : []),
          ...(s.status !== undefined && s.status !== 1 ? [{ reason: 'available_with_non_open_selection_status', selectionId: s.id }] : []),
          ...(s.settlement !== undefined && s.settlement !== 0 ? [{ reason: 'available_with_settlement', selectionId: s.id }] : []),
          ...(!priceValid(s) ? [{ reason: 'available_with_invalid_price', selectionId: s.id }] : []),
        ];
      });
      return { marketId: market.id, status: market.status, statusLabel: marketStatusLabel(market.status),
        counts: { selections: selections.length, validPrices: priced.length, invalidOrMissingPrices: selections.length - priced.length,
          availableTrue: selections.filter(s => s.available === true).length, selectableByExistingPriceAndFlagRules: selectable.length },
        availabilityCounts: count(selections.map(s => flag(s.available))), selectionStatusCounts: count(selections.map(s => statusKey(s.status))),
        settlementCounts: count(selections.map(s => statusKey(s.settlement))), selectionBlockingReasonCounts: selectionReasons,
        examples: { invalidOrMissingPriceSelectionIds: selections.filter(s => !priceValid(s)).slice(0, 3).map(s => s.id),
          blockedSelectionIds: blocked.slice(0, 3).map(s => s.id),
          byBlockingReason: Object.fromEntries(Object.keys(selectionReasons).map(reason => [reason, blocked.filter(s =>
            reason === 'not_reported_by_projection' ? !s.unavailableReasons?.length : s.unavailableReasons?.includes(reason)).slice(0, 3).map(s => s.id)])) },
        inconsistencies,
      };
    });
    const open = markets.filter(m => m.status === 1);
    const selections = markets.reduce((n, m) => n + m.counts.selections, 0);
    const prices = markets.reduce((n, m) => n + m.counts.validPrices, 0);
    const eligible = open.reduce((n, m) => n + m.counts.selectableByExistingPriceAndFlagRules, 0);
    if (!markets.length) reasons.add('markets_missing');
    if (!markets.length && event.selections?.length) reasons.add('primary_selections_without_markets');
    else if (!open.length) reasons.add('no_open_markets');
    if (markets.length && !selections) reasons.add('selections_missing');
    if (selections && !prices) reasons.add('no_valid_prices');
    if (open.length && !open.some(m => m.counts.selections)) reasons.add('open_markets_without_selections');
    if (open.some(m => m.counts.selections) && !open.some(m => m.counts.validPrices)) reasons.add('open_markets_without_valid_prices');
    if (open.some(m => m.counts.validPrices) && !eligible) reasons.add('open_markets_without_selectable_selections');
    if (markets.some(m => m.availabilityCounts.missing)) reasons.add('selection_availability_missing');
    if (markets.some(m => m.inconsistencies.length)) reasons.add('projection_inconsistency');
    if (event.available === true && [1, 2, 9].includes(event.status ?? 0) && eligible > 0) reasons.add('candidate_filter_inconsistency');
    return { ...identity, sport: event.sport, fixtureStatus: event.status, fixtureStatusLabel: event.statusLabel,
      eventAvailability: flag(event.available), marketsField: event.markets === undefined ? 'missing' : 'present', restored: !!event.restored,
      counts: { markets: markets.length, openMarkets: open.length, selections, validPrices: prices, selectableInOpenMarkets: eligible,
        primarySelections: event.selections?.length || 0, primaryValidPrices: (event.selections || []).filter(priceValid).length },
      marketStatusCounts: count(markets.map(m => statusKey(m.status))), exclusionReasons: [...reasons], markets };
  });
  const reasons = [...new Set(excluded.flatMap(e => e.exclusionReasons))].map(reason => {
    const matching = excluded.filter(e => e.exclusionReasons.includes(reason));
    return { reason, eventCount: matching.length, examples: matching.slice(0, 3).map(e => ({ eventId: e.eventId, fixtureId: e.fixtureId, source: e.source, competitionId: e.competitionId })) };
  });
  return { summary: { observedEvents: events.length, candidateEvents: events.filter(e => candidateIds.has(e.id)).length, excludedEvents: excluded.length,
    fixtureStatusCounts: count(excluded.map(e => statusKey(e.fixtureStatus))),
    marketStatusCounts: count(excluded.flatMap(e => e.markets.map(m => statusKey(m.status)))), reasons },
    excludedEvents: excluded,
    notes: ['Reasons may overlap; event counts must not be summed across reasons.',
      'Counts describe the current local projection only. Invalid/zero prices do not prove that a raw supplier price was absent.',
      'Projection inconsistencies are diagnostic evidence, not additional candidate filters.'],
  };
}
