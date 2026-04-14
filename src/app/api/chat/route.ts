/**
 * POST /api/chat — Booba chat endpoint.
 *
 * Authenticated via withAuth. Calls Claude API with tool_use, executing
 * shared tool functions with the verified wallet address injected. Loops
 * up to 3 tool-use rounds, then returns the final text response.
 */

import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/api-auth';
import * as tools from '@/services/tools';
import { resolveJournalFilterId } from '@/lib/journals';

const MAX_TOOL_ROUNDS = 5;

// ─── Claude tool definitions ────────────────────────────────────────────────

const toolDefinitions = [
  {
    name: 'get_positions',
    description: 'Get trading positions with optional filters. Use to answer questions about specific trades.',
    input_schema: {
      type: 'object' as const,
      properties: {
        asset: { type: 'string', description: 'Filter by asset (BTC, ETH, SOL, etc)' },
        direction: { type: 'string', enum: ['long', 'short'] },
        regime: { type: 'string', description: 'Market regime filter' },
        tradeType: { type: 'string', description: 'Trade type filter' },
        dateFrom: { type: 'string', description: 'ISO date string, start of range' },
        dateTo: { type: 'string', description: 'ISO date string, end of range' },
        limit: { type: 'number', description: 'Max positions to return, default 20' },
      },
    },
  },
  {
    name: 'get_position_detail',
    description: 'Get full details of a single position including orders and fills.',
    input_schema: {
      type: 'object' as const,
      properties: {
        positionId: { type: 'string', description: 'Position ID' },
      },
      required: ['positionId'],
    },
  },
  {
    name: 'get_performance_summary',
    description: 'Get overall trading performance: P&L, win rate, expectancy, profit factor.',
    input_schema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'get_wart_score',
    description: 'Get the WART (Wins Above Replacement Trader) composite score with 5 axes: entry, exit, risk, timing, discipline.',
    input_schema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'get_elo_rating',
    description: 'Get the trader Elo rating: current, peak, tier, trend, history.',
    input_schema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'get_insights',
    description: 'Get all detected behavioral and statistical insights with significance levels.',
    input_schema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'get_regime_breakdown',
    description: 'Get performance broken down by market regime (trending/ranging x high/low volatility).',
    input_schema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'get_asset_breakdown',
    description: 'Get performance broken down by asset (BTC, ETH, SOL, etc).',
    input_schema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'get_behavioral_patterns',
    description: 'Get behavioral analysis: tilt episodes, disposition effect, entropy, decision fatigue.',
    input_schema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'get_exit_analysis',
    description: 'Get exit quality analysis: MFE/MAE stats, exit efficiency, money left on table.',
    input_schema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'get_recent_trades',
    description: 'Get the N most recent trades. Use to discuss recent activity.',
    input_schema: {
      type: 'object' as const,
      properties: {
        n: { type: 'number', description: 'Number of recent trades, default 10' },
      },
    },
  },
  {
    name: 'get_open_positions',
    description: 'Get all currently open positions.',
    input_schema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'search_trades',
    description: 'Search trades by text across thesis, notes, strategy names, asset names.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search text' },
      },
      required: ['query'],
    },
  },
  {
    name: 'propose_group_action',
    description: 'Propose merging, linking, or splitting positions based on a natural language description. Returns a preview that the user must confirm.',
    input_schema: {
      type: 'object' as const,
      properties: {
        description: { type: 'string', description: 'Natural language description of what to group, e.g. "Find BTC/ETH counter-trades opened within 10 minutes"' },
      },
      required: ['description'],
    },
  },
  {
    name: 'propose_bulk_tag',
    description: 'Propose applying a tag/annotation to multiple positions matching a filter. Returns a preview that the user must confirm.',
    input_schema: {
      type: 'object' as const,
      properties: {
        field: { type: 'string', enum: ['strategy', 'thesis', 'emotion', 'sourceTag'], description: 'Which field to tag' },
        value: { type: 'string', description: 'Value to set' },
        asset: { type: 'string' },
        direction: { type: 'string' },
        regime: { type: 'string' },
        dateFrom: { type: 'string' },
        dateTo: { type: 'string' },
      },
      required: ['field', 'value'],
    },
  },
  {
    name: 'propose_journal_move',
    description: 'Propose moving positions matching a filter to a different journal. Returns a preview that the user must confirm.',
    input_schema: {
      type: 'object' as const,
      properties: {
        targetJournalName: { type: 'string', description: 'Name of the target journal' },
        asset: { type: 'string' },
        direction: { type: 'string' },
        regime: { type: 'string' },
        dateFrom: { type: 'string' },
        dateTo: { type: 'string' },
      },
      required: ['targetJournalName'],
    },
  },
  {
    name: 'propose_annotation',
    description: 'Propose annotating specific positions with strategy, thesis, emotion, or conviction.',
    input_schema: {
      type: 'object' as const,
      properties: {
        positionIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Position IDs to annotate',
        },
        strategy: { type: 'string' },
        thesis: { type: 'string' },
        emotion: { type: 'string' },
        conviction: { type: 'number' },
      },
      required: ['positionIds'],
    },
  },
  {
    name: 'execute_proposal',
    description: 'Execute a previously proposed write action after user confirmation. Requires the proposalId from a propose_* call.',
    input_schema: {
      type: 'object' as const,
      properties: {
        proposalId: { type: 'string' },
      },
      required: ['proposalId'],
    },
  },

  // ── New read tools ──────────────────────────────────────────────────────────
  {
    name: 'get_signals',
    description: 'Get trading signals/calls being tracked. Filter by status (open, hit_target, hit_stop, expired, partial_target) or by caller name.',
    input_schema: {
      type: 'object' as const,
      properties: {
        status: { type: 'string', description: 'Filter by status' },
        caller: { type: 'string', description: 'Filter by caller name' },
        limit: { type: 'number', description: 'Max results (default 20)' },
      },
    },
  },
  {
    name: 'get_caller_leaderboard',
    description: 'Get the caller signal leaderboard showing which signal callers have the best hit rates and R-multiples.',
    input_schema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'get_caller_analytics',
    description: 'Get detailed analytics for a specific signal caller including their win rate, Elo, WART scores, equity curve, and regime breakdown.',
    input_schema: {
      type: 'object' as const,
      properties: {
        callerName: { type: 'string', description: 'Name of the caller to analyze' },
      },
      required: ['callerName'],
    },
  },
  {
    name: 'get_carry_opportunities',
    description: "Get current carry trade opportunities on Pacifica based on funding rates, borrow costs, and the user's existing positions.",
    input_schema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'get_funding_status',
    description: "Check funding rate status for the user's open positions. Shows whether the user is paying or earning funding on each position and the annualized cost.",
    input_schema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'get_what_if_analysis',
    description: 'Get what-if equity curves showing how the trader would have performed with optimal exits, consistent sizing, or skipping their worst regime. Shows specific dollar amounts left on the table.',
    input_schema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'get_monte_carlo',
    description: 'Run a Monte Carlo risk simulation showing the probability of drawdowns and range of possible outcomes over the next 100 trades.',
    input_schema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'get_walk_forward',
    description: "Check if the trader's edge is persisting, improving, or declining over time by analyzing performance in sequential time windows.",
    input_schema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'get_current_regime',
    description: 'Get the current market regime (trending/ranging, high/low volatility) based on recent BTC price action.',
    input_schema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'get_playbooks',
    description: "Get the user's defined strategy playbooks with their rules and average adherence scores.",
    input_schema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'get_playbook_adherence',
    description: "Get adherence stats for a specific playbook — how well the trader follows its rules.",
    input_schema: {
      type: 'object' as const,
      properties: {
        playbookId: { type: 'string', description: 'ID of the playbook to check' },
      },
      required: ['playbookId'],
    },
  },
  {
    name: 'compare_periods',
    description: 'Compare trading performance between two time periods to check for improvement or decline.',
    input_schema: {
      type: 'object' as const,
      properties: {
        period1From: { type: 'string', description: 'Start date of first period (ISO format)' },
        period1To:   { type: 'string', description: 'End date of first period' },
        period2From: { type: 'string', description: 'Start date of second period' },
        period2To:   { type: 'string', description: 'End date of second period' },
      },
      required: ['period1From', 'period1To', 'period2From', 'period2To'],
    },
  },
  {
    name: 'assess_open_position_risk',
    description: 'Assess risk of current open positions. Shows total exposure, largest position as percentage of equity, whether positions are correlated (all long or all short), and margin utilization.',
    input_schema: { type: 'object' as const, properties: {} },
  },

  // ── New write/action tools ──────────────────────────────────────────────────
  {
    name: 'create_signal',
    description: 'Track a trading signal/call. Creates a signal entry that will be monitored against actual price data. Use when the user mentions a trade call to track.',
    input_schema: {
      type: 'object' as const,
      properties: {
        asset:        { type: 'string' },
        direction:    { type: 'string', enum: ['LONG', 'SHORT'] },
        entryPrice:   { type: 'number' },
        targetPrices: { type: 'array', items: { type: 'number' }, description: 'Take-profit levels' },
        stopPrice:    { type: 'number' },
        callerName:   { type: 'string' },
      },
      required: ['asset', 'direction', 'entryPrice', 'callerName'],
    },
  },
  {
    name: 'create_playbook',
    description: 'Create a new strategy playbook with structured rules. Use when the user describes their trading strategy and wants to track adherence.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name:        { type: 'string', description: 'Playbook name' },
        description: { type: 'string' },
        rules: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type:    { type: 'string', enum: ['direction', 'asset', 'regime', 'time_of_day', 'max_daily_trades', 'stop_distance', 'position_size', 'min_risk_reward', 'entry_near_ema'] },
              params:  { type: 'object' },
              label:   { type: 'string' },
            },
          },
          description: 'Array of rules for the playbook',
        },
      },
      required: ['name', 'rules'],
    },
  },
  {
    name: 'navigate_to',
    description: "Navigate the user to a specific page or analytics tab. Use when the user wants to see something specific like 'show me my exits analysis' or 'take me to signals'.",
    input_schema: {
      type: 'object' as const,
      properties: {
        page: { type: 'string', enum: ['dashboard', 'trades', 'analytics', 'signals', 'playbooks', 'settings'] },
        tab:  { type: 'string', description: 'Analytics tab: overview, strategy, execution, risk, psychology, insights' },
      },
      required: ['page'],
    },
  },
  {
    name: 'set_trades_filter',
    description: "Filter the trades page to show specific trades. Use when the user asks to see subsets like 'show my losing BTC trades' or 'show trades from last week'.",
    input_schema: {
      type: 'object' as const,
      properties: {
        direction:  { type: 'string', enum: ['LONG', 'SHORT'] },
        assets:     { type: 'array', items: { type: 'string' } },
        regimes:    { type: 'array', items: { type: 'string' } },
        pnlFilter:  { type: 'string', enum: ['winners', 'losers', 'all'] },
        dateFrom:   { type: 'string' },
        dateTo:     { type: 'string' },
        strategy:   { type: 'string' },
        playbook:   { type: 'string' },
      },
    },
  },
];

// ─── Tool executor ──────────────────────────────────────────────────────────

async function executeTool(
  name: string,
  args: Record<string, any>,
  wallet: string,
  journalId?: string,
): Promise<any> {
  switch (name) {
    case 'get_positions':
      return tools.getPositions(wallet, journalId, args);
    case 'get_position_detail':
      return tools.getPositionDetail(wallet, args.positionId);
    case 'get_performance_summary':
      return tools.getPerformanceSummary(wallet, journalId);
    case 'get_wart_score':
      return tools.getWartScore(wallet, journalId);
    case 'get_elo_rating':
      return tools.getEloRating(wallet, journalId);
    case 'get_insights':
      return tools.getInsights(wallet, journalId);
    case 'get_regime_breakdown':
      return tools.getRegimeBreakdown(wallet, journalId);
    case 'get_asset_breakdown':
      return tools.getAssetBreakdown(wallet, journalId);
    case 'get_behavioral_patterns':
      return tools.getBehavioralPatterns(wallet, journalId);
    case 'get_exit_analysis':
      return tools.getExitAnalysis(wallet, journalId);
    case 'get_recent_trades':
      return tools.getRecentTrades(wallet, args.n);
    case 'get_open_positions':
      return tools.getOpenPositions(wallet);
    case 'search_trades':
      return tools.searchTrades(wallet, args.query);
    case 'propose_group_action':
      return tools.proposeGroupAction(wallet, args.description);
    case 'propose_bulk_tag':
      return tools.proposeBulkTag(wallet, args.field, args.value, {
        asset: args.asset,
        direction: args.direction,
        regime: args.regime,
        dateFrom: args.dateFrom,
        dateTo: args.dateTo,
      });
    case 'propose_journal_move':
      return tools.proposeJournalMove(wallet, {
        asset: args.asset,
        direction: args.direction,
        regime: args.regime,
        dateFrom: args.dateFrom,
        dateTo: args.dateTo,
      }, args.targetJournalName);
    case 'propose_annotation':
      return tools.proposeAnnotation(wallet, args.positionIds, {
        strategy: args.strategy,
        thesis: args.thesis,
        emotion: args.emotion,
        conviction: args.conviction,
      });
    case 'execute_proposal':
      return tools.executeProposal(wallet, args.proposalId);

    // ── New read tools ──────────────────────────────────────────────────────
    case 'get_signals':
      return tools.getSignals(wallet, args);
    case 'get_caller_leaderboard':
      return tools.getCallerLeaderboard(wallet);
    case 'get_caller_analytics':
      return tools.getCallerAnalytics(wallet, args.callerName);
    case 'get_carry_opportunities':
      return tools.getCarryOpportunities(wallet);
    case 'get_funding_status':
      return tools.getFundingStatus(wallet);
    case 'get_what_if_analysis':
      return tools.getWhatIfAnalysis(wallet, journalId);
    case 'get_monte_carlo':
      return tools.getMonteCarloSimulation(wallet, journalId);
    case 'get_walk_forward':
      return tools.getWalkForwardValidation(wallet, journalId);
    case 'get_current_regime':
      return tools.getCurrentRegime(wallet);
    case 'get_playbooks':
      return tools.getPlaybooks(wallet);
    case 'get_playbook_adherence':
      return tools.getPlaybookAdherence(wallet, args.playbookId);
    case 'compare_periods':
      return tools.comparePeriods(
        wallet,
        { from: args.period1From, to: args.period1To },
        { from: args.period2From, to: args.period2To },
        journalId,
      );
    case 'assess_open_position_risk':
      return tools.assessOpenPositionRisk(wallet);

    // ── New write/action tools ──────────────────────────────────────────────
    case 'create_signal':
      return tools.createSignalFromChat(wallet, args);
    case 'create_playbook':
      return tools.createPlaybookFromChat(wallet, args);
    case 'navigate_to':
      return tools.navigateTo(args);
    case 'set_trades_filter':
      return tools.setTradesFilter(wallet, args);

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ─── Route handler ──────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  return withAuth(req, async (walletAddress) => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: 'ANTHROPIC_API_KEY not configured' },
        { status: 500 },
      );
    }

    let body: { messages: { role: string; content: string }[]; journalId?: string };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
      return NextResponse.json({ error: 'messages array required' }, { status: 400 });
    }

    // Resolve journal
    const journalRes = await resolveJournalFilterId(walletAddress, body.journalId ?? null);
    const journalId = journalRes.valid ? journalRes.id ?? undefined : undefined;

    // Load baseline context
    let baselineContext = '';
    try {
      const perf = await tools.getPerformanceSummary(walletAddress, journalId);
      const elo = await tools.getEloRating(walletAddress, journalId);
      const wart = await tools.getWartScore(walletAddress, journalId);
      const insights = await tools.getInsights(walletAddress, journalId);
      const topInsight = insights.length > 0 ? insights[0].title : 'No insights yet';

      baselineContext = `
Key facts about this trader:
- Elo: ${Math.round(elo.currentElo)} (${elo.tier}), peak: ${Math.round(elo.peakElo)}
- WART: ${wart.composite.toFixed(1)} (${wart.tier})
- Win rate: ${(perf.winRate * 100).toFixed(1)}%, ${perf.tradeCount} total trades
- Total P&L: $${perf.totalPnl.toFixed(2)}
- Expectancy: $${perf.expectancy.toFixed(2)} per trade
- Profit factor: ${perf.profitFactor === 999 ? 'Infinite (no losses)' : perf.profitFactor.toFixed(2)}
- Top insight: ${topInsight}
- WART improvements: ${wart.improvements.slice(0, 2).join('; ') || 'None'}`;
    } catch (err) {
      console.error('[chat] Failed to load baseline context:', err);
      baselineContext = '\nTrader data is still being computed. Use tools to look up specific data.';
    }

    const systemPrompt = `You are Booba, an AI trading copilot for Pacifica DEX. You're friendly, data-driven, and slightly playful — but always professional about trading analysis. You know the trader personally through their data.
${baselineContext}

When asked questions, use your tools to look up specific data. Don't guess — always check the data first.

For write operations (grouping, tagging, moving), always propose the change and ask for confirmation before executing. Never auto-execute writes.

Keep responses concise — 2-3 sentences for simple questions, more for analysis requests. Use specific numbers from the data, not vague statements.

When asked broad diagnostic questions like 'why am I losing money', 'what should I improve', or 'how am I doing':
1. Call get_performance_summary for the big picture
2. Call get_behavioral_patterns for psychological issues
3. Call get_exit_analysis for execution quality
4. Call get_regime_breakdown for strategy fit
Synthesize findings across all tools. Lead with the highest-dollar-impact finding. Be specific with numbers.

When asked about risk, call get_monte_carlo and assess_open_position_risk.

When asked about funding costs or carry trades, use get_funding_status and get_carry_opportunities.

When asked to compare time periods, use compare_periods.

When asked about callers or signals, use get_caller_leaderboard and get_caller_analytics.

When the user asks to see something ('show me my BTC trades', 'take me to exits'), use navigate_to or set_trades_filter to manipulate the UI directly rather than just describing the data.

When the user describes a strategy, offer to create a playbook for it using create_playbook.

When the user mentions a trade call or signal, offer to track it using create_signal.

You can perform actions, not just answer questions. Be proactive — if analysis reveals something the user should see, navigate them there.

When assess_open_position_risk shows correlationWarning=true, proactively mention it: 'All your open positions are in the same direction — consider hedging.' If the largest position pctOfEquity exceeds 10, flag it.

When reporting on trade performance, always compute and cite aggregate statistics: win rate, expectancy (average P&L per trade), total P&L, and trade count. Do not list individual trades unless specifically asked. Compare subsets to the overall baseline: 'Your BTC longs: 38% win rate, -$4.20 expectancy vs your 41.6% overall baseline.'

Keep responses concise. Lead with the key finding in one sentence, then support with 2-3 specific numbers. Avoid bullet-pointed lists of every metric — highlight what matters most.`;

    // Build message history — map to Claude format
    type ClaudeMessage = {
      role: 'user' | 'assistant';
      content: string | any[];
    };

    const messages: ClaudeMessage[] = body.messages.map((m) => ({
      role: m.role === 'assistant' ? 'assistant' as const : 'user' as const,
      content: m.content,
    }));

    // Tool-use loop
    let currentMessages = [...messages];
    let round = 0;
    const pendingActions: any[] = [];

    while (round < MAX_TOOL_ROUNDS) {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1024,
          system: systemPrompt,
          messages: currentMessages,
          tools: toolDefinitions,
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error('[chat] Claude API error:', response.status, errText);
        return NextResponse.json(
          { error: 'Failed to get response from Booba' },
          { status: 502 },
        );
      }

      const result = await response.json();

      // Check if response contains tool_use blocks
      const toolUseBlocks = (result.content || []).filter(
        (block: any) => block.type === 'tool_use',
      );

      if (toolUseBlocks.length === 0) {
        // No more tool calls — extract final text
        const textBlocks = (result.content || []).filter(
          (block: any) => block.type === 'text',
        );
        const finalText = textBlocks.map((b: any) => b.text).join('\n');

        return NextResponse.json({
          response: finalText,
          stop_reason: result.stop_reason,
          ...(pendingActions.length > 0 ? { actions: pendingActions } : {}),
        });
      }

      // Execute tools and build tool_result messages
      const toolResults: any[] = [];
      for (const toolBlock of toolUseBlocks) {
        try {
          const toolResult = await executeTool(
            toolBlock.name,
            toolBlock.input || {},
            walletAddress,
            journalId,
          );
          // Collect frontend action instructions
          if (toolBlock.name === 'navigate_to' || toolBlock.name === 'set_trades_filter') {
            pendingActions.push({ type: toolBlock.name, ...toolResult });
          }
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolBlock.id,
            content: JSON.stringify(toolResult),
          });
        } catch (err: any) {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolBlock.id,
            content: JSON.stringify({ error: err.message }),
            is_error: true,
          });
        }
      }

      // Add assistant response + tool results to conversation
      currentMessages.push({ role: 'assistant', content: result.content });
      currentMessages.push({ role: 'user', content: toolResults });

      round++;
    }

    // Hit max rounds — return whatever we have
    return NextResponse.json({
      response: "I've been looking through a lot of data. Could you rephrase your question more specifically?",
      stop_reason: 'max_tool_rounds',
      ...(pendingActions.length > 0 ? { actions: pendingActions } : {}),
    });
  });
}
