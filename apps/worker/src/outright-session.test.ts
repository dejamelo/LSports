import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import amqp, { type ConsumeMessage } from 'amqplib';
import { session } from './connected.js';
import { TradeState } from './state.js';
import type { PackageConfig } from './config.js';
import type { ProviderClients } from './provider.js';

for (const scenario of ['ok', 'persist_failure', 'malformed', 'unknown'] as const) {
  test(`outright market delivery ${scenario}: never ACK before publication and requeue failures`, { timeout: 8000 }, async () => {
    const state = new TradeState();
    const abort = new AbortController();
    let callback: (msg: ConsumeMessage | null) => void = () => {};
    let acks = 0;
    let nacks = 0;
    let persisted = false;
    let failedWrite = false;
    const channel = Object.assign(new EventEmitter(), {
      async prefetch() {},
      async consume(_queue: string, cb: typeof callback, options: { noAck: boolean }) {
        assert.equal(options.noAck, false);
        callback = cb;
        return { consumerTag: 'test' };
      },
      ack() { assert(persisted); acks++; },
      nack(_msg: ConsumeMessage, all: boolean, requeue: boolean) {
        assert.equal(all, false); assert.equal(requeue, true); nacks++;
      },
    });
    const connection = Object.assign(new EventEmitter(), {
      async createChannel() { return channel; },
      async close() { connection.emit('close'); },
    });
    const pkg: PackageConfig = { lane: 'prematch', packageId: 4511, username: 'test-only', password: '',
      hostname: 'stm-prematch.lsports.eu', vhost: 'StmPreMatch', queue: '_4511_', port: 5672, tls: false };
    const client: ProviderClients = {
      async distributionStatus() { return { isDistributionOn: true, consumers: [], numberMessagesInQueue: 0, messagesPerSecond: 0 }; },
      async startDistribution() {}, async catalog() { return []; },
      async snapshot() {
        state.apply('prematch', [{ fixtureId: 100, outright: { competitionId: 90,
          fixture: { sport: { name: 'Horse Racing' }, status: 1, participants: [{ id: 1, name: 'Test runner' }] } } }], Date.now());
        const msg = { content: Buffer.from(JSON.stringify({
          Header: { Type: scenario === 'unknown' ? 40 : 41, MsgGuid: 'test-market', ServerTimestamp: Date.now() },
          Body: { Competition: { Id: 90, Events: [{ FixtureId: 100,
            Markets: scenario === 'malformed' ? [{ Name: 'private malformed market' }] :
              [{ Id: 160, Status: 1, Bets: [{ Id: '1', ParticipantId: 1, Price: '3.25', Status: 1 }] }] }] } },
        })), properties: {}, fields: { redelivered: true } } as unknown as ConsumeMessage;
        callback(msg);
        callback(msg); // Duplicate delivery: persist first; never double-apply.
        return [];
      },
    };
    const execution = session(pkg, { packages: [pkg], snapshotUrl: 'https://stm-snapshot.lsports.eu',
      customersUrl: 'https://stm-api.lsports.eu', recoveryMs: 300000, staleMs: 90000 }, state,
      async () => {
        const race = state.feed().events[0];
        if (scenario === 'persist_failure' && race?.selections.length && !failedWrite) {
          failedWrite = true;
          throw new Error('Simulated local write failure');
        }
        if (race?.selections.length) {
          assert.equal(race.participants?.length, 1);
          persisted = true;
        }
        if (state.connections.prematch.phase === 'connected') abort.abort();
      }, abort.signal, {
        connect: (async () => connection) as unknown as typeof amqp.connect,
        clientFactory: () => client,
      });
    if (scenario === 'ok') {
      await execution;
      assert.equal(acks, 2);
      assert.equal(nacks, 0);
      assert.equal(state.feed().events[0].marketDiagnostic?.messagesByType['41'], 1);
    } else {
      await assert.rejects(execution);
      assert.equal(acks, 0);
      assert.equal(nacks, 1);
      assert.equal(state.connections.prematch.diagnostic?.deliveryDisposition, 'requeue_requested');
      assert(!JSON.stringify(state.connections).includes('private malformed market'));
    }
  });
}
