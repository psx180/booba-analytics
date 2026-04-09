import { z } from 'zod';
import { PacificaBaseClient } from '../client';
import { apiResponse } from '../types/common';

const ApiKeySchema = z.object({
  api_key: z.string(),
  created_at: z.number().optional(),
});

export class ApiKeysAPI {
  constructor(private client: PacificaBaseClient) {}

  /**
   * Create a new API config key. Returns the key string.
   * Store it in your env as PF_API_KEY and pass it to PacificaClient({ apiConfigKey }).
   * Requires signing — privateKey or agentPrivateKey must be configured.
   * Up to 5 keys per account.
   */
  async create(): Promise<string> {
    const body = this.client.sign('create_api_key', {});
    const res = await this.client.post(
      '/account/api_keys/create',
      body,
      apiResponse(ApiKeySchema),
    );
    return res.data.api_key;
  }

  async list() {
    const body = this.client.sign('list_api_keys', {});
    return this.client.post(
      '/account/api_keys',
      body,
      apiResponse(z.array(ApiKeySchema)),
    ).then((r) => r.data);
  }

  async revoke(apiKey: string) {
    const body = this.client.sign('revoke_api_key', { api_key: apiKey });
    return this.client.post(
      '/account/api_keys/revoke',
      body,
      z.object({ success: z.boolean() }),
    );
  }
}
