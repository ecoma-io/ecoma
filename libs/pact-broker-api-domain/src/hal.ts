/**
 * HAL builder — port từ upstream `src/services/hal.ts` (REUSE). Import type
 * đổi sang `../domain/types`. Mọi relation giữ nguyên tên vì Pact CLI điều
 * hướng qua chúng (xem docs/applications/pact-broker/UPSTREAM_MAPPING.md §5).
 */
import type { HalLinks, HalLink } from './types';

/**
 * Helper dựng HAL _links cho API response
 */
export class HalBuilder {
  readonly baseUrl: string;

  constructor(baseUrl: string) {
    // Bỏ trailing slash
    this.baseUrl = baseUrl.replace(/\/$/u, '');
  }

  link(path: string, title?: string, templated?: boolean): HalLink {
    const link: HalLink = { href: `${this.baseUrl}${path}` };
    if (title) link.title = title;
    if (templated) link.templated = true;
    return link;
  }

  // Các pattern link phổ biến
  index(): HalLinks {
    return {
      self: this.link('/'),
      'pb:pacticipants': this.link('/pacticipants', 'Pacticipants'),
      'pb:latest-pact-versions': this.link('/pacts/latest', 'Latest pact versions'),
      'pb:pact': this.link(
        '/pacts/provider/{provider}/consumer/{consumer}/latest',
        'Latest pact by consumer/provider',
        true,
      ),
      'pb:provider-pacts-for-verification': this.link(
        '/pacts/provider/{provider}/for-verification',
        'Pact versions to verify for the specified provider',
        true,
      ),
      'pb:environments': this.link('/environments', 'Environments'),
      'pb:environment': this.link('/environments/{uuid}', 'Environment', true),
      'pb:publish-contracts': this.link('/contracts/publish', 'Publish contracts'),
      // pact-broker-client điều hướng các link này từ index, không từ
      // pacticipant. `pb:pacticipant-branch-version` đặc biệt gates toàn bộ
      // flow `publish --branch` (versions/create.rb#branch_versions_supported?)
      // — thiếu nó thì CLI không ghi branch nào mà vẫn báo thành công.
      'pb:pacticipant-version': this.link(
        '/pacticipants/{pacticipant}/versions/{version}',
        'Get, create or delete a pacticipant version',
        true,
      ),
      'pb:pacticipant-branch-version': this.link(
        '/pacticipants/{pacticipant}/branches/{branch}/versions/{version}',
        'Get or add/create a pacticipant version for a branch',
        true,
      ),
      'pb:pacticipant-version-tag': this.link(
        '/pacticipants/{pacticipant}/versions/{version}/tags/{tag}',
        'Get, create or delete a tag for a pacticipant version',
        true,
      ),
    };
  }

  pacticipant(name: string): HalLinks {
    const p = encodeURIComponent(name);
    return {
      self: this.link(`/pacticipants/${p}`),
      'pb:versions': this.link(`/pacticipants/${p}/versions`, 'Versions'),
      // Verifier publish với provider branch điều hướng pb:provider tới
      // resource này rồi theo pb:branch-version; thiếu link thì pact-reference
      // bỏ cả kết quả publish. {branch} và {version} giữ nguyên — client tự điền.
      'pb:branch-version': this.link(
        `/pacticipants/${p}/branches/{branch}/versions/{version}`,
        'Branch version',
        true,
      ),
    };
  }

  version(pacticipant: string, version: string): HalLinks {
    const p = encodeURIComponent(pacticipant);
    const v = encodeURIComponent(version);
    return {
      self: this.link(`/pacticipants/${p}/versions/${v}`),
      'pb:pacticipant': this.link(`/pacticipants/${p}`),
      'pb:tags': this.link(`/pacticipants/${p}/versions/${v}/tags`, 'Tags'),
    };
  }

  /**
   * Một link `pb:record-deployment` mỗi environment, mỗi link có `name` riêng.
   * `pact-broker record-deployment` đọc collection này từ version resource và
   * POST tới entry có `name` khớp `--environment`
   * (record_release.rb#get_record_action_relation).
   */
  recordDeployment(pacticipant: string, version: string, environmentNames: string[]): HalLink[] {
    const p = encodeURIComponent(pacticipant);
    const v = encodeURIComponent(version);
    return environmentNames.map((environment) => ({
      ...this.link(
        `/pacticipants/${p}/versions/${v}/deployed-versions/environment/${encodeURIComponent(environment)}`,
        `Record deployment to ${environment}`,
      ),
      name: environment,
    }));
  }

  tag(pacticipant: string, version: string, tagName: string): HalLinks {
    const p = encodeURIComponent(pacticipant);
    const v = encodeURIComponent(version);
    const t = encodeURIComponent(tagName);
    return {
      self: this.link(`/pacticipants/${p}/versions/${v}/tags/${t}`),
      'pb:version': this.link(`/pacticipants/${p}/versions/${v}`),
    };
  }

  pact(provider: string, consumer: string, version: string, contentSha: string): HalLinks {
    const pr = encodeURIComponent(provider);
    const co = encodeURIComponent(consumer);
    const v = encodeURIComponent(version);
    return {
      self: this.link(`/pacts/provider/${pr}/consumer/${co}/version/${v}`),
      'pb:consumer': this.link(`/pacticipants/${co}`),
      'pb:provider': this.link(`/pacticipants/${pr}`),
      'pb:consumer-version': this.link(`/pacticipants/${co}/versions/${v}`),
      'pb:publish-verification-results': this.link(
        `/pacts/provider/${pr}/consumer/${co}/pact-version/${contentSha}/verification-results`,
        'Publish verification results',
      ),
      'pb:latest-pact-version': this.link(`/pacts/provider/${pr}/consumer/${co}/latest`),
    };
  }

  verification(
    provider: string,
    consumer: string,
    pactSha: string,
    // uuid ở schema PG — upstream dùng integer; URL shape không đổi.
    verificationId: string,
  ): HalLinks {
    const pr = encodeURIComponent(provider);
    const co = encodeURIComponent(consumer);
    return {
      self: this.link(
        `/pacts/provider/${pr}/consumer/${co}/pact-version/${pactSha}/verification-results/${verificationId}`,
      ),
      'pb:pact-version': this.link(`/pacts/provider/${pr}/consumer/${co}/latest`),
    };
  }

  matrix(): HalLinks {
    return {
      self: this.link('/matrix'),
    };
  }

  canIDeploy(): HalLinks {
    return {
      self: this.link('/can-i-deploy'),
    };
  }

  environment(name: string): HalLinks {
    const n = encodeURIComponent(name);
    return {
      self: this.link(`/environments/${n}`),
    };
  }

  deployment(pacticipant: string, version: string, environment: string): HalLinks {
    const p = encodeURIComponent(pacticipant);
    const v = encodeURIComponent(version);
    const e = encodeURIComponent(environment);
    return {
      self: this.link(`/pacticipants/${p}/versions/${v}/deployed/${e}`),
      'pb:version': this.link(`/pacticipants/${p}/versions/${v}`),
      'pb:environment': this.link(`/environments/${e}`),
    };
  }

  pactsForVerification(provider: string): HalLinks {
    const pr = encodeURIComponent(provider);
    return {
      self: this.link(`/pacts/provider/${pr}/for-verification`),
      'pb:provider': this.link(`/pacticipants/${pr}`),
    };
  }
}

/**
 * Rút base URL từ request
 */
export function getBaseUrl(request: Request): string {
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}
