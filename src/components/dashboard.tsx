"use client";

import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  ChevronRight,
  Plus,
  Radar,
  RefreshCw,
  WalletCards,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { MobileShell } from "@/components/mobile-shell";
import { PushEnrollment } from "@/components/push-enrollment";
import type { DashboardData } from "@/lib/domain";
import {
  formatRelativeTime,
  formatUsd,
  shortAddress,
} from "@/lib/client-format";
import styles from "./dashboard.module.css";

export function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [observedAt, setObservedAt] = useState(0);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setRefreshing(true);
    try {
      const response = await fetch("/api/addresses", { cache: "no-store" });
      const payload = (await response.json()) as DashboardData & { message?: string };
      if (!response.ok) throw new Error(payload.message || "无法读取监视状态。");
      setData(payload);
      setObservedAt(Date.now());
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "无法读取监视状态。");
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const initialTimer = window.setTimeout(() => void load(), 0);
    const timer = window.setInterval(() => void load(true), 60_000);
    return () => {
      window.clearTimeout(initialTimer);
      window.clearInterval(timer);
    };
  }, [load]);

  const totals = useMemo(() => {
    const addresses = data?.addresses ?? [];
    return {
      positions: addresses.reduce((sum, address) => sum + address.positionCount, 0),
      pnl: addresses.reduce((sum, address) => sum + Number(address.unrealizedPnl || 0), 0),
    };
  }, [data]);

  const workerStale = data?.worker
    ? observedAt - new Date(data.worker.updatedAt).getTime() > Math.max(180_000, data.monitorIntervalMs * 3)
    : true;
  const workerHealthy = Boolean(data?.worker && !workerStale && data.worker.state !== "error");

  return (
    <MobileShell>
      <header className={styles.header}>
        <div className={styles.brand}>
          <span className={styles.brandMark} aria-hidden="true"><span /></span>
          <div>
            <strong>HYPERSCOPE</strong>
            <small>HYPERLIQUID POSITION WATCH</small>
          </div>
        </div>
        <button
          className={styles.refreshButton}
          type="button"
          aria-label="刷新监视状态"
          onClick={() => void load()}
          disabled={refreshing}
        >
          <RefreshCw className={refreshing ? styles.spinning : undefined} size={17} />
        </button>
      </header>

      <section className={styles.hero} aria-labelledby="watch-count-title">
        <div>
          <p id="watch-count-title">正在监视</p>
          <div className={styles.countLine}>
            <strong>{data?.addresses.length ?? 0}</strong>
            <span>个地址</span>
          </div>
          <div className={styles.liveStatus}>
            <span className={workerHealthy ? styles.liveDot : styles.offlineDot} aria-hidden="true" />
            {workerHealthy ? "监视器在线 · 每 60 秒扫描" : "监视器尚未在线"}
          </div>
        </div>
        <div className={styles.radar} aria-hidden="true">
          <span /><span /><span />
          <Radar size={30} />
        </div>
      </section>

      <section className={styles.stats} aria-label="仓位概览">
        <div>
          <span>当前仓位</span>
          <strong>{totals.positions}</strong>
        </div>
        <div>
          <span>合计未实现盈亏</span>
          <strong className={totals.pnl >= 0 ? styles.positive : styles.negative}>
            {formatUsd(totals.pnl, true)}
          </strong>
        </div>
      </section>

      <PushEnrollment />

      <section className={styles.addressSection}>
        <div className={styles.sectionHeading}>
          <div>
            <span>WATCHLIST</span>
            <h2>监视地址</h2>
          </div>
          <Link href="/addresses/new" className={styles.addLink}>
            <Plus size={16} aria-hidden="true" />
            添加
          </Link>
        </div>

        {error && (
          <div className={styles.errorCard} role="alert">
            <AlertTriangle size={18} aria-hidden="true" />
            <div><strong>暂时无法读取</strong><p>{error}</p></div>
            <button type="button" onClick={() => void load()}>重试</button>
          </div>
        )}

        {!data && !error && (
          <div className={styles.loadingList} aria-label="正在加载地址">
            <span /><span />
          </div>
        )}

        {data && data.addresses.length === 0 && (
          <div className={styles.emptyState}>
            <span><WalletCards size={23} aria-hidden="true" /></span>
            <h3>还没有监视地址</h3>
            <p>添加一个公开地址，HyperScope 会每分钟读取一次默认永续仓位。</p>
            <Link href="/addresses/new">
              添加第一个地址 <ArrowUpRight size={16} aria-hidden="true" />
            </Link>
          </div>
        )}

        <div className={styles.addressList}>
          {data?.addresses.map((address) => {
            const pnl = Number(address.unrealizedPnl);
            return (
              <Link key={address.id} href={`/addresses/${address.id}`} className={styles.addressCard}>
                <div className={styles.addressTop}>
                  <span className={address.status === "healthy" ? styles.addressIcon : styles.addressIconError}>
                    {address.status === "error" ? <AlertTriangle size={17} /> : <Activity size={17} />}
                  </span>
                  <div className={styles.addressIdentity}>
                    <strong>{address.label || shortAddress(address.address)}</strong>
                    <small>{address.label ? shortAddress(address.address) : `${formatRelativeTime(address.lastCheckedAt)}更新`}</small>
                  </div>
                  <ChevronRight size={18} aria-hidden="true" />
                </div>
                <div className={styles.addressMetrics}>
                  <div><span>账户价值</span><strong>{formatUsd(address.accountValue, true)}</strong></div>
                  <div><span>仓位</span><strong>{address.positionCount}</strong></div>
                  <div>
                    <span>未实现盈亏</span>
                    <strong className={pnl >= 0 ? styles.positive : styles.negative}>{formatUsd(pnl, true)}</strong>
                  </div>
                </div>
                {address.status === "error" && (
                  <p className={styles.inlineError}>{address.errorMessage || "最近一次检查失败"}</p>
                )}
              </Link>
            );
          })}
        </div>
      </section>

      <footer className={styles.footerNote}>
        <span><span aria-hidden="true" /> MAINNET</span>
        <p>只读取公开链上数据，不需要私钥</p>
      </footer>
    </MobileShell>
  );
}
