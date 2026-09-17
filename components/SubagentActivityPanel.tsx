"use client";

import { useEffect, useRef } from "react";
import {
  subagentTaskTitle,
  type SubagentActivity,
  type SubagentToolEvent,
} from "@/lib/subagent/activity";

interface Props {
  activity: readonly SubagentActivity[];
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onClose: () => void;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${Math.round(seconds - minutes * 60)}s`;
}

function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  return `${Math.round(count / 1000)}k`;
}

/**
 * Spinner for a dispatch still in flight.
 *
 * `strokeDasharray` + rotation gives the partial-arc sweep used by most coding
 * UIs; it reads as "working" far better than a static dot, which is what made
 * a running worker indistinguishable from a finished one.
 */
function RunSpinner({ color = "var(--accent)" }: { color?: string }) {
  return (
    <svg
      className="subagent-spinner"
      width={12}
      height={12}
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden="true"
      style={{ flexShrink: 0 }}
    >
      <circle cx="6" cy="6" r="4.5" stroke="var(--border)" strokeWidth="1.6" opacity={0.5} />
      <circle
        cx="6"
        cy="6"
        r="4.5"
        stroke={color}
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeDasharray="20 28"
      />
    </svg>
  );
}

function ToolStatusIcon({ status }: { status: SubagentToolEvent["status"] }) {
  if (status === "running") return <RunSpinner />;
  const stroke = status === "ok" ? "var(--success)" : "var(--danger)";
  const path = status === "ok" ? "M2 5.5L4.5 8L9 2.5" : "M2.5 2.5L8.5 8.5M8.5 2.5L2.5 8.5";
  return (
    <svg width={11} height={11} viewBox="0 0 11 11" fill="none" stroke={stroke} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }} aria-hidden="true">
      <path d={path} />
    </svg>
  );
}

function DispatchRow({ entry, running, expanded }: { entry: SubagentActivity; running: boolean; expanded: boolean }) {
  const { details } = entry;
  const thinkingRef = useRef<HTMLDivElement>(null);
  const pinnedToBottomRef = useRef(true);

  // Follow the stream only while the reader is already at the bottom, so
  // scrolling back to read earlier reasoning is not yanked away.
  useEffect(() => {
    const node = thinkingRef.current;
    if (!node || !pinnedToBottomRef.current) return;
    node.scrollTop = node.scrollHeight;
  }, [details.thinking]);

  const handleThinkingScroll = () => {
    const node = thinkingRef.current;
    if (!node) return;
    pinnedToBottomRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 24;
  };

  const toolErrors = details.tools.filter((tool) => tool.status === "error").length;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        flex: expanded ? "1 1 auto" : "0 0 auto",
        gap: 4,
        padding: "6px 10px 8px",
        borderBottom: "1px solid var(--border)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
        {running ? <RunSpinner /> : (
          <svg width={12} height={12} viewBox="0 0 12 12" fill="none" stroke={details.status === "failed" ? "var(--danger)" : "var(--success)"} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }} aria-hidden="true">
            {details.status === "failed" ? <path d="M3 3l6 6M9 3l-6 6" /> : <path d="M2.5 6.5L5 9l5-6" />}
          </svg>
        )}
        <span
          style={{
            fontSize: 12,
            color: "var(--text)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            minWidth: 0,
            flex: 1,
          }}
          title={subagentTaskTitle(details.task)}
        >
          {subagentTaskTitle(details.task)}
        </span>
        <span
          style={{
            fontSize: 11,
            fontFamily: "var(--font-mono)",
            color: "var(--text-muted)",
            flexShrink: 0,
          }}
          title={`${details.model.provider}/${details.model.modelId}${details.modelSource === "inherited" ? " (inherited from the main session)" : ""}`}
        >
          {details.model.modelId}
        </span>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontSize: 11,
          color: "var(--text-dim)",
          flexWrap: "wrap",
        }}
      >
        <span>{details.phase || "—"}</span>
        <span>· {details.turns} turns</span>
        <span>· {details.tools.length} tools{toolErrors > 0 ? ` (${toolErrors} failed)` : ""}</span>
        <span>· {formatDuration(details.durationMs)}</span>
        {details.tokens ? <span>· {formatTokens(details.tokens.total)} tok</span> : null}
        {typeof details.costUsd === "number" ? <span>· ${details.costUsd.toFixed(4)}</span> : null}
      </div>

      <div
        ref={thinkingRef}
        onScroll={handleThinkingScroll}
        style={{
          // A lone dispatch owns the whole view, so its reasoning can use all
          // the leftover height. With several rows the panel scrolls as a
          // list instead, and each row caps its own reasoning block.
          flex: expanded && running ? "1 1 auto" : "0 0 auto",
          minHeight: expanded && running ? 120 : running ? 40 : 0,
          maxHeight: expanded ? undefined : running ? 200 : 96,
          overflowY: "auto",
          fontSize: 12,
          lineHeight: 1.55,
          color: "var(--text-muted)",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {details.thinking.trim()
          ? details.thinking
          : <span style={{ color: "var(--text-dim)" }}>No reasoning emitted.</span>}
      </div>

      {details.tools.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
          {details.tools.slice(-6).map((tool) => (
            <div
              key={tool.seq}
              style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, padding: "1px 0" }}
            >
              <ToolStatusIcon status={tool.status} />
              <span style={{ fontFamily: "var(--font-mono)", color: "var(--text)", flexShrink: 0 }}>
                {tool.name}
              </span>
              <span
                style={{
                  color: "var(--text-dim)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  minWidth: 0,
                }}
                title={tool.summary}
              >
                {tool.summary}
              </span>
            </div>
          ))}
          {details.tools.length > 6 && (
            <div style={{ fontSize: 11, color: "var(--text-dim)", paddingTop: 2 }}>
              +{details.tools.length - 6} earlier
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Live view of what delegated workers are doing.
 *
 * Rendered inside the right-hand panel beside the file workbench. Worker
 * reasoning is deliberately kept out of the main transcript: it is a lot of
 * low-signal text that would push the conversation around, and reading it is
 * an optional inspection step rather than part of the dialogue.
 */
export function SubagentActivityPanel({ activity, collapsed, onToggleCollapsed, onClose }: Props) {
  return (
    <section
      aria-label="Subagent activity"
      style={{
        display: "flex",
        flexDirection: "column",
        // Fills the whole content area of the right panel. It is a peer view of
        // the file workbench, not a strip beside it, so it never competes with
        // the file preview for height — switching views swaps one for the other.
        flex: "1 1 auto",
        minHeight: 0,
        overflow: "hidden",
        background: "var(--bg-panel)",
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 8px 6px 10px",
          flexShrink: 0,
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>
          Subagent
        </span>
        <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
          {activity.length} dispatch{activity.length === 1 ? "" : "es"}
        </span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          onClick={onToggleCollapsed}
          title={collapsed ? "Expand subagent activity" : "Collapse subagent activity"}
          aria-expanded={!collapsed}
          style={{
            border: "none",
            background: "none",
            color: "var(--text-muted)",
            cursor: "pointer",
            padding: 4,
            borderRadius: "var(--radius-sm)",
            display: "flex",
          }}
        >
          <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ transform: collapsed ? "rotate(-90deg)" : "none", transition: "transform 0.15s" }}>
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
        <button
          type="button"
          onClick={onClose}
          title="Hide subagent activity"
          style={{
            border: "none",
            background: "none",
            color: "var(--text-muted)",
            cursor: "pointer",
            padding: 4,
            borderRadius: "var(--radius-sm)",
            display: "flex",
          }}
        >
          <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </header>

      {!collapsed && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            minHeight: 0,
            flex: "1 1 auto",
            // One row stretches; several scroll as a list.
            overflowY: activity.length === 1 ? "hidden" : "auto",
            overscrollBehavior: "contain",
          }}
        >
          {activity.map((entry) => (
            <DispatchRow
              key={entry.toolCallId}
              entry={entry}
              running={!entry.finished}
              expanded={activity.length === 1}
            />
          ))}
        </div>
      )}
    </section>
  );
}
