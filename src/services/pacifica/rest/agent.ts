import { z } from 'zod';
import { PacificaBaseClient } from '../client';
import { apiResponse } from '../types/common';

const SuccessResponse = z.object({ success: z.boolean() });

export class AgentAPI {
  constructor(private client: PacificaBaseClient) {}

  async bindAgentWallet(agentWalletAddress: string) {
    const body = this.client.sign('bind_agent_wallet', { agent_wallet: agentWalletAddress });
    return this.client.post('/agent/bind', body, SuccessResponse);
  }

  async listAgentWallets() {
    const body = this.client.sign('list_agent_wallets', {});
    return this.client.post('/agent/list', body, apiResponse(z.array(z.unknown()))).then((r) => r.data);
  }

  async revokeAgentWallet(agentWalletAddress: string) {
    const body = this.client.sign('revoke_agent_wallet', { agent_wallet: agentWalletAddress });
    return this.client.post('/agent/revoke', body, SuccessResponse);
  }

  async revokeAllAgentWallets() {
    const body = this.client.sign('revoke_all_agent_wallets', {});
    return this.client.post('/agent/revoke_all', body, SuccessResponse);
  }

  async listIpWhitelist(agentWalletAddress: string) {
    const body = this.client.sign('list_agent_ip_whitelist', { api_agent_key: agentWalletAddress });
    return this.client.post('/agent/ip_whitelist/list', body, apiResponse(z.array(z.unknown()))).then((r) => r.data);
  }

  async addIpToWhitelist(agentWalletAddress: string, ipAddress: string) {
    const body = this.client.sign('add_agent_whitelisted_ip', {
      agent_wallet: agentWalletAddress,
      ip_address: ipAddress,
    });
    return this.client.post('/agent/ip_whitelist/add', body, SuccessResponse);
  }

  async removeIpFromWhitelist(agentWalletAddress: string, ipAddress: string) {
    const body = this.client.sign('remove_agent_whitelisted_ip', {
      agent_wallet: agentWalletAddress,
      ip_address: ipAddress,
    });
    return this.client.post('/agent/ip_whitelist/remove', body, SuccessResponse);
  }

  async toggleIpWhitelist(agentWalletAddress: string, enabled: boolean) {
    const body = this.client.sign('set_agent_ip_whitelist_enabled', {
      agent_wallet: agentWalletAddress,
      enabled,
    });
    return this.client.post('/agent/ip_whitelist/toggle', body, SuccessResponse);
  }
}