/**
 * Port từ upstream `test/matrix-summary.unit.test.ts` — reason wording là
 * contract wire: expected string chép tay từ source Ruby tham chiếu, KHÔNG
 * bao giờ ghép bằng helper dưới test.
 */
import { describe, it, expect } from 'vitest';
import { summarizeMatrix } from './matrix-summary';

describe('summarizeMatrix', () => {
  it('reports the failure as well as the unverified pact', () => {
    const { summary } = summarizeMatrix([
      {
        consumer: { name: 'company-manager', version: '5a5fb620' },
        provider: { name: 'agent-books', version: 'p-1.0.0' },
        success: false,
      },
      {
        consumer: { name: 'company-manager', version: '5a5fb620' },
        provider: { name: 'agent-books-auth', version: null },
        success: null,
      },
    ]);

    expect(summary.reason).toBe(
      'The verification for the pact between version 5a5fb620 of company-manager and any version of agent-books failed\n' +
        'There is no verified pact between version 5a5fb620 of company-manager and any version of agent-books-auth',
    );
  });

  it('counts a passing, a failing and an unverified row separately', () => {
    const { summary } = summarizeMatrix([
      {
        consumer: { name: 'c', version: '1' },
        provider: { name: 'p-ok', version: '9' },
        success: true,
      },
      {
        consumer: { name: 'c', version: '1' },
        provider: { name: 'p-bad', version: '9' },
        success: false,
      },
      {
        consumer: { name: 'c', version: '1' },
        provider: { name: 'p-none', version: null },
        success: null,
      },
    ]);

    expect(summary.success).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.unknown).toBe(1);
  });

  // deployment_status_summary.rb#deployable? is tri-state: false only when
  // something is known bad, nil while anything is unknown, true otherwise.
  it('is not deployable when a verification failed', () => {
    const { summary } = summarizeMatrix([
      {
        consumer: { name: 'c', version: '1' },
        provider: { name: 'p', version: '9' },
        success: false,
      },
    ]);

    expect(summary.deployable).toBe(false);
  });

  it('has an unknown deployability when a pact is unverified', () => {
    const { summary } = summarizeMatrix([
      {
        consumer: { name: 'c', version: '1' },
        provider: { name: 'p', version: null },
        success: null,
      },
    ]);

    expect(summary.deployable).toBeNull();
  });

  it('is deployable when every pact passed', () => {
    const { summary } = summarizeMatrix([
      {
        consumer: { name: 'c', version: '1' },
        provider: { name: 'p', version: '9' },
        success: true,
      },
    ]);

    expect(summary.deployable).toBe(true);
    expect(summary.reason).toBe('All required verification results are published and successful');
  });

  // matrix_decorator.rb#notices — the same reasons, typed. `error` comes from
  // ErrorReason#type, `info` from Reason#type.
  it('emits each reason as a typed notice', () => {
    const { notices } = summarizeMatrix([
      {
        consumer: { name: 'c', version: '1' },
        provider: { name: 'p', version: '9' },
        success: false,
      },
    ]);

    expect(notices).toEqual([
      {
        type: 'error',
        text: 'The verification for the pact between version 1 of c and any version of p failed',
      },
    ]);
  });

  it('types a success notice as info', () => {
    const { notices } = summarizeMatrix([
      {
        consumer: { name: 'c', version: '1' },
        provider: { name: 'p', version: '9' },
        success: true,
      },
    ]);

    expect(notices).toEqual([
      { type: 'info', text: 'All required verification results are published and successful' },
    ]);
  });

  it('reports no missing dependencies when there is nothing to check', () => {
    const { summary } = summarizeMatrix([]);

    expect(summary.deployable).toBe(true);
    expect(summary.reason).toBe('There are no missing dependencies');
  });

  // Tri-state là contract can-i-deploy fail-closed: unknown KHÔNG được rơi
  // về true (đó là lỗ hổng deploy pact chưa verify).
  it('never collapses unknown into deployable', () => {
    const { summary } = summarizeMatrix([
      {
        consumer: { name: 'c', version: '1' },
        provider: { name: 'p1', version: '2' },
        success: true,
      },
      {
        consumer: { name: 'c', version: '1' },
        provider: { name: 'p2', version: null },
        success: null,
      },
    ]);

    expect(summary.deployable).toBeNull();
  });
});
