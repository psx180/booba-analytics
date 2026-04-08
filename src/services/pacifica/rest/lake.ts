import { z } from 'zod';
import { PacificaBaseClient } from '../client';

const SuccessResponse = z.object({ success: z.boolean() });

export class LakeAPI {
  constructor(private client: PacificaBaseClient) {}

  async createLake(manager: string, nickname?: string) {
    const payload: Record<string, unknown> = { manager };
    if (nickname) payload.nickname = nickname;
    const body = this.client.sign('create_lake', payload);
    return this.client.post('/lake/create', body, z.unknown());
  }

  async lakeDeposit(lakeAddress: string, amount: string) {
    const body = this.client.sign('deposit_to_lake', { lake: lakeAddress, amount });
    return this.client.post('/lake/deposit', body, SuccessResponse);
  }

  async lakeWithdraw(lakeAddress: string, shares: string) {
    const body = this.client.sign('withdraw_from_lake', { lake: lakeAddress, shares });
    return this.client.post('/lake/withdraw', body, SuccessResponse);
  }
}