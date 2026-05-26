import { useState, useEffect } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { api, type UsageData } from "@/api";

function fmt(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return n.toLocaleString();
}

function modelLabel(model: string): string {
  return model
    .replace(/^claude-/, "")
    .replace(/-20\d{6}$/, "")
    .replace(/-\d{8}$/, "");
}

export function Usage() {
  const [data, setData] = useState<UsageData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getUsage().then(setData).finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-24 text-sm text-muted-foreground">
        Loading…
      </div>
    );
  }

  const claude = data?.claude;

  if (!claude) {
    return (
      <div className="flex flex-col items-center justify-center h-32 gap-2 text-sm text-muted-foreground px-6 text-center">
        <p>No usage data found.</p>
        <p className="text-xs">Claude Code writes stats to ~/.claude/stats-cache.json</p>
      </div>
    );
  }

  const totalOutput = Object.values(claude.modelUsage).reduce((s, m) => s + m.outputTokens, 0);
  const totalInput = Object.values(claude.modelUsage).reduce((s, m) => s + m.inputTokens, 0);
  const totalCacheRead = Object.values(claude.modelUsage).reduce((s, m) => s + m.cacheReadInputTokens, 0);
  const totalCacheWrite = Object.values(claude.modelUsage).reduce((s, m) => s + m.cacheCreationInputTokens, 0);

  const chartDays = claude.dailyModelTokens.slice(-30);
  const chartTotals = chartDays.map(d => ({
    date: d.date,
    total: Object.values(d.tokensByModel).reduce((s, t) => s + t, 0),
  }));
  const maxTotal = Math.max(...chartTotals.map(d => d.total), 1);

  return (
    <ScrollArea className="flex-1 h-full">
      <div className="p-4 space-y-5">
        {/* Summary cards */}
        <div className="grid grid-cols-3 gap-2">
          {[
            { label: "Sessions", value: claude.totalSessions.toLocaleString() },
            { label: "Messages", value: fmt(claude.totalMessages) },
            { label: "Output", value: fmt(totalOutput) },
          ].map(({ label, value }) => (
            <div key={label} className="rounded-lg border bg-card p-3 text-center">
              <p className="text-lg font-semibold tabular-nums">{value}</p>
              <p className="text-xs text-muted-foreground mt-0.5">{label}</p>
            </div>
          ))}
        </div>

        {/* 30-day bar chart */}
        {chartTotals.length > 0 && (
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-2">
              Daily tokens — last {chartTotals.length} days
            </p>
            <div className="flex items-end gap-px h-14">
              {chartTotals.map(d => (
                <div
                  key={d.date}
                  className="flex-1 bg-primary/30 rounded-sm hover:bg-primary/50 transition-colors"
                  style={{ height: `${Math.max(3, (d.total / maxTotal) * 100)}%` }}
                  title={`${d.date}: ${d.total.toLocaleString()} tokens`}
                />
              ))}
            </div>
          </div>
        )}

        {/* Per-model breakdown */}
        <div>
          <p className="text-xs font-medium text-muted-foreground mb-2">By model</p>
          <div className="space-y-2">
            {Object.entries(claude.modelUsage).map(([model, usage]) => (
              <div key={model} className="rounded-lg border bg-card p-3">
                <p className="text-sm font-medium mb-2">{modelLabel(model)}</p>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                  <span className="text-muted-foreground">Input</span>
                  <span className="text-right tabular-nums">{fmt(usage.inputTokens)}</span>
                  <span className="text-muted-foreground">Output</span>
                  <span className="text-right tabular-nums">{fmt(usage.outputTokens)}</span>
                  <span className="text-muted-foreground">Cache read</span>
                  <span className="text-right tabular-nums">{fmt(usage.cacheReadInputTokens)}</span>
                  <span className="text-muted-foreground">Cache write</span>
                  <span className="text-right tabular-nums">{fmt(usage.cacheCreationInputTokens)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* All-time totals */}
        <div className="rounded-lg border bg-card p-3">
          <p className="text-sm font-medium mb-2">All-time totals</p>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
            <span className="text-muted-foreground">Input</span>
            <span className="text-right tabular-nums">{fmt(totalInput)}</span>
            <span className="text-muted-foreground">Output</span>
            <span className="text-right tabular-nums">{fmt(totalOutput)}</span>
            <span className="text-muted-foreground">Cache read</span>
            <span className="text-right tabular-nums">{fmt(totalCacheRead)}</span>
            <span className="text-muted-foreground">Cache write</span>
            <span className="text-right tabular-nums">{fmt(totalCacheWrite)}</span>
          </div>
        </div>

        <p className="text-xs text-muted-foreground text-center pb-2">Source: Claude Code · ~/.claude/stats-cache.json</p>
      </div>
    </ScrollArea>
  );
}
