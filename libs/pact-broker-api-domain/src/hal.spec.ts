/**
 * Port từ upstream `test/hal.unit.test.ts` — relation names là contract CLI:
 * `pb:branch-version` thiếu templated flag hoặc tên %-encode sai braces là
 * publish --branch chết im lặng phía client.
 */
import { describe, it, expect } from 'vitest';
import { HalBuilder, getBaseUrl } from './hal';

describe('HalBuilder', () => {
  it('link() returns fully-qualified href', () => {
    const hal = new HalBuilder('https://broker.example.com');
    expect(hal.link('/pacticipants')).toEqual({
      href: 'https://broker.example.com/pacticipants',
    });
  });

  it('link() title + templated flags pass through', () => {
    const hal = new HalBuilder('https://broker.example.com');
    expect(hal.link('/p/{name}', 'pact', true)).toEqual({
      href: 'https://broker.example.com/p/{name}',
      title: 'pact',
      templated: true,
    });
  });

  it('trailing slash in base URL is normalized', () => {
    const hal = new HalBuilder('https://broker.example.com/');
    expect(hal.link('/x').href).toBe('https://broker.example.com/x');
  });

  it('pact() returns expected _links record with all keys', () => {
    const hal = new HalBuilder('https://broker.example.com');
    const links = hal.pact('prov', 'cons', '1.0.0', 'a'.repeat(64));
    expect(Object.keys(links).toSorted()).toEqual([
      'pb:consumer',
      'pb:consumer-version',
      'pb:latest-pact-version',
      'pb:provider',
      'pb:publish-verification-results',
      'self',
    ]);
    expect(links.self?.href).toBe(
      'https://broker.example.com/pacts/provider/prov/consumer/cons/version/1.0.0',
    );
  });

  // pacticipant_decorator.rb defines pb:branch-version on the pacticipant
  // resource; pact-reference's publish_provider_branch navigates pb:provider
  // to find it, then substitutes {branch} and {version}. Percent-encoding the
  // braces would leave the client with a URL it cannot template.
  it('pacticipant() advertises a templated pb:branch-version link', () => {
    const hal = new HalBuilder('https://broker.example.com');
    const links = hal.pacticipant('agent-books');

    expect(links['pb:branch-version']).toEqual({
      href: 'https://broker.example.com/pacticipants/agent-books/branches/{branch}/versions/{version}',
      title: 'Branch version',
      templated: true,
    });
  });

  it('pacticipant() percent-encodes the name but not the template variables', () => {
    const hal = new HalBuilder('https://broker.example.com');
    const links = hal.pacticipant('a b');

    expect(links['pb:branch-version']).toMatchObject({
      href: 'https://broker.example.com/pacticipants/a%20b/branches/{branch}/versions/{version}',
    });
  });

  it('pact() percent-encodes names with special chars', () => {
    const hal = new HalBuilder('https://broker.example.com');
    const links = hal.pact('p/rov', 'c ons', '1.0.0', 'a'.repeat(64));
    expect(links.self?.href).toContain('/provider/p%2Frov/consumer/c%20ons/');
  });

  // recordDeployment: mỗi environment một link, `name` khớp --environment —
  // pact-broker record-deployment chọn link theo `name`, không phải href.
  it('recordDeployment() names each link after its environment', () => {
    const hal = new HalBuilder('https://broker.example.com');
    const links = hal.recordDeployment('app', '1.0.0', ['prod', 'staging']);

    expect(links).toHaveLength(2);
    expect(links[0]?.name).toBe('prod');
    expect(links[0]?.href).toBe(
      'https://broker.example.com/pacticipants/app/versions/1.0.0/deployed-versions/environment/prod',
    );
    expect(links[1]?.name).toBe('staging');
  });
});

describe('getBaseUrl', () => {
  it('preserves scheme and host from request URL', () => {
    const req = new Request('https://public-host.example.com/some/path');
    expect(getBaseUrl(req)).toBe('https://public-host.example.com');
  });

  it('works for http too', () => {
    const req = new Request('http://localhost:9090/health');
    expect(getBaseUrl(req)).toBe('http://localhost:9090');
  });
});
