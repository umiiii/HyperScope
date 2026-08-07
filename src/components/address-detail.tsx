"use client";

import {
  ArrowDownRight,
  ArrowLeft,
  ArrowUpRight,
  Check,
  Clipboard,
  Gauge,
  LoaderCircle,
  RefreshCw,
  Repeat2,
  Trash2,
  TrendingDown,
  TrendingUp,
  X,
  Zap,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { MobileShell } from "@/components/mobile-shell";
import type { AddressDetail, PositionEvent } from "@/lib/domain";
import type { PositionSnapshot } from "@/lib/hyperliquid/types";
import {
  formatDateTime,
  formatNumber,
  formatRelativeTime,
  formatUsd,
  shortAddress,
} from "@/lib/client-format";
import styles from "./address-detail.module.css";

type AddressDetailViewProps = { id: string };

function eventMeta(kind: PositionEvent["kind"]) {
  switch (kind) {
    case "opened":
      return { label: "开仓", tone: "positive", icon: ArrowUpRight };
    case "closed":
      return { label: "平仓", tone: "neutral", icon: X };
    case "increased":
      return { label: "加仓", tone: "positive", icon: TrendingUp };
    case "reduced":
      return { label: "减仓", tone: "warning", icon: TrendingDown };
    case "flipped":
      return { label: "反向", tone: "warning", icon: Repeat2 };
    case "leverage_changed":
      return { label: "杠杆", tone: "warning", icon: Gauge };
    case "entry_price_changed":
      return { label: "均价", tone: "warning", icon: Zap };
    default:
      return { label: "开始", tone: "neutral", icon: Check };
  }
}

function markPrice(position: PositionSnapshot) {
  const size = Math.abs(Number(position.size));
  return size > 0 ? Math.abs(Number(position.positionValue)) / size : 0;
}

export function AddressDetailView({ id }: AddressDetailViewProps) {
  const router = useRouter();
  const [detail, setDetail] = useState<AddressDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setRefreshing(true);
    try {
      const response = await fetch(`/api/addresses/${id}`, { cache: "no-store" });
      const payload = (await response.json()) as AddressDetail & { message?: string };
      if (!response.ok) throw new Error(payload.message || "无法读取地址仓位。");
      setDetail(payload);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "无法读取地址仓位。");
    } finally {
      setRefreshing(false);
    }
  }, [id]);

  useEffect(() => {
    const initialTimer = window.setTimeout(() => void load(), 0);
    const timer = window.setInterval(() => void load(true), 60_000);
    return () => {
      window.clearTimeout(initialTimer);
      window.clearInterval(timer);
    };
  }, [load]);

  async function refreshNow() {
    setRefreshing(true);
    setError(null);
    try {
      const response = await fetch(`/api/addresses/${id}/refresh`, { method: "POST" });
      const payload = (await response.json()) as { success?: boolean; error?: string; message?: string };
      if (!response.ok) throw new Error(payload.error || payload.message || "刷新失败。");
      await load(true);
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : "刷新失败。");
    } finally {
      setRefreshing(false);
    }
  }

  async function copyAddress() {
    if (!detail) return;
    try {
      await navigator.clipboard.writeText(detail.address);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      setError("无法复制地址。");
    }
  }

  async function removeAddress() {
    if (!detail || !window.confirm(`停止监视 ${detail.label || shortAddress(detail.address)}？`)) return;
    setDeleting(true);
    try {
      const response = await fetch(`/api/addresses/${id}`, { method: "DELETE" });
      if (!response.ok) throw new Error("停止监视失败。");
      router.push("/");
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "停止监视失败。");
      setDeleting(false);
    }
  }

  return (
    <MobileShell>
      <header className={styles.header}>
        <Link href="/" aria-label="返回监视列表"><ArrowLeft size={19} /></Link>
        <div><strong>{detail?.label || "地址详情"}</strong><small>POSITION DETAIL</small></div>
        <button type="button" onClick={refreshNow} disabled={refreshing} aria-label="立即刷新仓位">
          <RefreshCw className={refreshing ? styles.spinner : undefined} size={18} />
        </button>
      </header>

      {!detail && !error && (
        <div className={styles.loading} aria-label="正在加载仓位">
          <span /><span /><span />
        </div>
      )}

      {error && !detail && (
        <section className={styles.fatalError} role="alert">
          <Zap size={24} />
          <h1>暂时无法读取</h1>
          <p>{error}</p>
          <button type="button" onClick={() => void load()}>重新加载</button>
        </section>
      )}

      {detail && (
        <>
          <section className={styles.identity}>
            <div>
              <p>{detail.label || "MONITORED ADDRESS"}</p>
              <button type="button" onClick={copyAddress}>
                {shortAddress(detail.address)}
                {copied ? <Check size={14} /> : <Clipboard size={14} />}
              </button>
            </div>
            <span className={detail.status === "healthy" ? styles.statusHealthy : styles.statusError}>
              <span aria-hidden="true" />
              {detail.status === "healthy" ? "监视中" : detail.status === "pending" ? "建立基线" : "检查异常"}
            </span>
          </section>

          <section className={styles.accountCard}>
            <div className={styles.accountValue}>
              <span>账户价值</span>
              <strong>{formatUsd(detail.accountValue)}</strong>
              <small>{formatRelativeTime(detail.lastCheckedAt)}更新</small>
            </div>
            <div className={styles.accountGrid}>
              <div><span>可提取</span><strong>{formatUsd(detail.withdrawable, true)}</strong></div>
              <div><span>保证金占用</span><strong>{formatUsd(detail.totalMarginUsed, true)}</strong></div>
              <div>
                <span>未实现盈亏</span>
                <strong className={Number(detail.unrealizedPnl) >= 0 ? styles.positive : styles.negative}>
                  {formatUsd(detail.unrealizedPnl, true)}
                </strong>
              </div>
            </div>
          </section>

          {detail.status === "error" && (
            <p className={styles.monitorError} role="status">{detail.errorMessage || "最近一次 Hyperliquid 检查失败，旧仓位快照已保留。"}</p>
          )}
          {error && <p className={styles.monitorError} role="alert">{error}</p>}

          <section className={styles.section}>
            <div className={styles.sectionHeading}>
              <div><span>OPEN POSITIONS</span><h2>当前仓位</h2></div>
              <strong>{detail.positions.length}</strong>
            </div>

            {detail.positions.length === 0 ? (
              <div className={styles.emptyPositions}>
                <span><ArrowDownRight size={20} /></span>
                <strong>当前没有永续仓位</strong>
                <p>HyperScope 会继续每分钟检查，检测到开仓后显示在这里。</p>
              </div>
            ) : (
              <div className={styles.positionList}>
                {detail.positions.map((position) => {
                  const isLong = Number(position.size) > 0;
                  const pnl = Number(position.unrealizedPnl);
                  return (
                    <article key={position.coin} className={styles.positionCard}>
                      <div className={styles.positionTop}>
                        <div>
                          <strong>{position.coin}</strong>
                          <span className={isLong ? styles.longBadge : styles.shortBadge}>{isLong ? "LONG" : "SHORT"}</span>
                        </div>
                        <div className={styles.pnl}>
                          <span>未实现盈亏</span>
                          <strong className={pnl >= 0 ? styles.positive : styles.negative}>{formatUsd(pnl)}</strong>
                        </div>
                      </div>
                      <div className={styles.positionMetrics}>
                        <div><span>数量</span><strong>{formatNumber(Math.abs(Number(position.size)))}</strong></div>
                        <div><span>入场价</span><strong>{position.entryPrice ? formatUsd(position.entryPrice) : "—"}</strong></div>
                        <div><span>标记价</span><strong>{formatUsd(markPrice(position))}</strong></div>
                        <div><span>仓位价值</span><strong>{formatUsd(position.positionValue, true)}</strong></div>
                        <div><span>杠杆</span><strong>{position.leverageValue}x · {position.leverageType === "cross" ? "全仓" : "逐仓"}</strong></div>
                        <div><span>清算价</span><strong>{position.liquidationPrice ? formatUsd(position.liquidationPrice) : "—"}</strong></div>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </section>

          <section className={styles.section}>
            <div className={styles.sectionHeading}>
              <div><span>CHANGE LOG</span><h2>仓位变动</h2></div>
              <strong>{detail.events.filter((event) => event.kind !== "monitor_started").length}</strong>
            </div>
            <div className={styles.timeline}>
              {detail.events.map((event) => {
                const meta = eventMeta(event.kind);
                const Icon = meta.icon;
                return (
                  <article key={event.id} className={styles.event}>
                    <span className={`${styles.eventIcon} ${styles[meta.tone]}`}><Icon size={15} aria-hidden="true" /></span>
                    <div>
                      <div className={styles.eventTitle}>
                        <strong>{event.coin || "HyperScope"}</strong>
                        <span>{meta.label}</span>
                      </div>
                      <p>{event.summary}</p>
                      <small>{formatDateTime(event.detectedAt)}</small>
                    </div>
                  </article>
                );
              })}
            </div>
          </section>

          <button className={styles.deleteButton} type="button" onClick={removeAddress} disabled={deleting}>
            {deleting ? <LoaderCircle className={styles.spinner} size={17} /> : <Trash2 size={17} />}
            停止监视并删除记录
          </button>
        </>
      )}
    </MobileShell>
  );
}
