"use client";

import { ArrowLeft, Clipboard, LoaderCircle, LockKeyhole, Radar } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";
import { MobileShell } from "@/components/mobile-shell";
import styles from "./add-address.module.css";

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

export function AddAddress() {
  const router = useRouter();
  const [address, setAddress] = useState("");
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function pasteAddress() {
    try {
      const value = await navigator.clipboard.readText();
      setAddress(value.trim());
      setError(null);
    } catch {
      setError("无法读取剪贴板，请手动粘贴地址。");
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const cleanAddress = address.trim();
    if (!ADDRESS_PATTERN.test(cleanAddress)) {
      setError("请输入 0x 开头的 42 位地址。");
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/addresses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: cleanAddress, label: label.trim() }),
      });
      const payload = (await response.json()) as {
        id?: string;
        existingId?: string | null;
        message?: string;
      };

      if (response.status === 409 && payload.existingId) {
        router.push(`/addresses/${payload.existingId}`);
        return;
      }
      if (!response.ok || !payload.id) {
        throw new Error(payload.message || "添加地址失败。");
      }

      router.push(`/addresses/${payload.id}`);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "添加地址失败。");
      setSubmitting(false);
    }
  }

  return (
    <MobileShell>
      <header className={styles.header}>
        <Link href="/" aria-label="返回监视列表"><ArrowLeft size={19} /></Link>
        <span>ADD WATCH</span>
        <div aria-hidden="true" />
      </header>

      <section className={styles.intro}>
        <span className={styles.icon}><Radar size={24} aria-hidden="true" /></span>
        <p>NEW MONITOR</p>
        <h1>添加观察地址</h1>
        <span>保存后会立即读取一次当前仓位作为基线，之后每分钟自动检查变化。</span>
      </section>

      <form className={styles.form} onSubmit={submit}>
        <label className={styles.field}>
          <span>Hyperliquid 地址</span>
          <div className={styles.addressInput}>
            <input
              type="text"
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              placeholder="0x…"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              inputMode="text"
              disabled={submitting}
              aria-describedby="address-help"
            />
            <button type="button" onClick={pasteAddress} disabled={submitting} aria-label="从剪贴板粘贴地址">
              <Clipboard size={17} />
            </button>
          </div>
          <small id="address-help">主账户或子账户公开地址，不要填写 API Agent 地址</small>
        </label>

        <label className={styles.field}>
          <span>备注名 <em>可选</em></span>
          <input
            type="text"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="例如：主账户"
            maxLength={32}
            disabled={submitting}
          />
        </label>

        {error && <p className={styles.error} role="alert">{error}</p>}

        <button className={styles.submit} type="submit" disabled={submitting}>
          {submitting ? <LoaderCircle className={styles.spinner} size={19} /> : <Radar size={19} />}
          {submitting ? "正在建立仓位基线" : "开始监视"}
        </button>
      </form>

      <aside className={styles.privacyNote}>
        <LockKeyhole size={18} aria-hidden="true" />
        <div>
          <strong>只读，无需授权</strong>
          <p>HyperScope 只使用 Hyperliquid 的公开 Info API，永远不会要求钱包签名或私钥。</p>
        </div>
      </aside>
    </MobileShell>
  );
}
