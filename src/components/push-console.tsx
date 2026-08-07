"use client";

import {
  Bell,
  Check,
  Download,
  LoaderCircle,
  LockKeyhole,
  Send,
  Share,
  Smartphone,
  Unplug,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import styles from "./push-console.module.css";

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};

type PushConfig = {
  configured: boolean;
  publicKey: string | null;
  requiresToken: boolean;
  message?: string;
};

type SetupPhase =
  | "booting"
  | "ready"
  | "needs-install"
  | "unsupported"
  | "unconfigured"
  | "error";

type ResultMessage = {
  kind: "success" | "error";
  text: string;
} | null;

const DEFAULT_MESSAGE = "HyperScope 已成功抵达你的设备。";

function urlBase64ToUint8Array(value: string) {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = `${value}${padding}`.replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  return Uint8Array.from(rawData, (character) => character.charCodeAt(0));
}

function detectIOS() {
  const classicIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const modernIPad =
    navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
  return classicIOS || modernIPad;
}

function detectStandalone() {
  const iosNavigator = navigator as Navigator & { standalone?: boolean };
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    iosNavigator.standalone === true
  );
}

function explainError(error: unknown) {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError") {
      return "通知权限未开启。请在系统设置中允许通知后重试。";
    }
    if (error.name === "InvalidStateError") {
      return "应用尚未准备好，请刷新页面后重试。";
    }
    if (error.name === "AbortError") {
      return "订阅被浏览器中断，请稍后再试。";
    }
  }

  if (error instanceof Error && error.message) {
    return error.message;
  }

  return "操作没有完成，请稍后重试。";
}

export function PushConsole() {
  const registrationRef = useRef<ServiceWorkerRegistration | null>(null);
  const applicationKeyRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const [phase, setPhase] = useState<SetupPhase>("booting");
  const [config, setConfig] = useState<PushConfig | null>(null);
  const [subscription, setSubscription] = useState<PushSubscription | null>(null);
  const [permission, setPermission] = useState<NotificationPermission>("default");
  const [isIOS, setIsIOS] = useState(false);
  const [isStandalone, setIsStandalone] = useState(false);
  const [isSecure, setIsSecure] = useState(true);
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null);
  const [showInstallHelp, setShowInstallHelp] = useState(false);
  const [message, setMessage] = useState(DEFAULT_MESSAGE);
  const [adminToken, setAdminToken] = useState("");
  const [busy, setBusy] = useState<"subscribe" | "send" | "install" | null>(null);
  const [result, setResult] = useState<ResultMessage>(null);

  useEffect(() => {
    let active = true;
    const ios = detectIOS();
    const standalone = detectStandalone();

    queueMicrotask(() => {
      if (!active) return;
      setIsIOS(ios);
      setIsStandalone(standalone);
      setIsSecure(window.isSecureContext);
      if ("Notification" in window) {
        setPermission(Notification.permission);
      }
    });

    const onInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as InstallPromptEvent);
    };

    const onInstalled = () => {
      setInstallPrompt(null);
      setIsStandalone(true);
      setResult({ kind: "success", text: "应用已安装，可以继续开启推送。" });
    };

    window.addEventListener("beforeinstallprompt", onInstallPrompt);
    window.addEventListener("appinstalled", onInstalled);

    async function prepare() {
      try {
        const configResponse = await fetch("/api/push/config", { cache: "no-store" });
        const pushConfig = (await configResponse.json()) as PushConfig;

        if (!active) return;
        setConfig(pushConfig);

        if (!pushConfig.configured || !pushConfig.publicKey) {
          setPhase("unconfigured");
          return;
        }

        applicationKeyRef.current = urlBase64ToUint8Array(pushConfig.publicKey);

        if (!window.isSecureContext || !("serviceWorker" in navigator)) {
          setPhase("unsupported");
          return;
        }

        const registration = await navigator.serviceWorker.register("/sw.js", {
          scope: "/",
          updateViaCache: "none",
        });
        const readyRegistration = await navigator.serviceWorker.ready;

        if (!active) return;
        registrationRef.current = readyRegistration ?? registration;

        if (!("PushManager" in window) || !("Notification" in window)) {
          setPhase(ios && !standalone ? "needs-install" : "unsupported");
          return;
        }

        const currentSubscription =
          await registrationRef.current.pushManager.getSubscription();

        if (!active) return;
        setSubscription(currentSubscription);
        setPhase(ios && !standalone ? "needs-install" : "ready");
      } catch (error) {
        if (!active) return;
        setPhase("error");
        setResult({ kind: "error", text: explainError(error) });
      }
    }

    void prepare();

    return () => {
      active = false;
      window.removeEventListener("beforeinstallprompt", onInstallPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const status = useMemo(() => {
    if (phase === "booting") return { label: "正在检查", tone: "neutral" };
    if (phase === "unconfigured") return { label: "等待配置", tone: "warning" };
    if (phase === "needs-install") return { label: "先安装应用", tone: "warning" };
    if (phase === "unsupported") return { label: "当前环境不支持", tone: "danger" };
    if (phase === "error") return { label: "初始化失败", tone: "danger" };
    if (subscription) return { label: "推送已开启", tone: "positive" };
    return { label: "可以开始", tone: "positive" };
  }, [phase, subscription]);

  const permissionLabel =
    permission === "granted" ? "已允许" : permission === "denied" ? "已拒绝" : "未请求";

  async function handleInstall() {
    setResult(null);

    if (installPrompt) {
      setBusy("install");
      try {
        await installPrompt.prompt();
        const choice = await installPrompt.userChoice;
        if (choice.outcome === "accepted") {
          setInstallPrompt(null);
          setResult({ kind: "success", text: "安装请求已接受，请从主屏幕打开应用。" });
        }
      } finally {
        setBusy(null);
      }
      return;
    }

    setShowInstallHelp((current) => !current);
  }

  async function handleSubscribe() {
    const registration = registrationRef.current;
    const applicationServerKey = applicationKeyRef.current;

    if (!registration || !applicationServerKey || phase !== "ready") {
      setResult({ kind: "error", text: "推送服务尚未准备好。" });
      return;
    }

    setResult(null);

    try {
      // iOS 要求订阅直接发生在用户点击事件中，因此先调用 subscribe，再更新 UI。
      const subscribePromise = registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey,
      });
      setBusy("subscribe");
      const nextSubscription = await subscribePromise;
      setSubscription(nextSubscription);
      setPermission(Notification.permission);
      setResult({ kind: "success", text: "这台设备已订阅，可以发送测试通知。" });
    } catch (error) {
      setPermission("Notification" in window ? Notification.permission : "default");
      setResult({ kind: "error", text: explainError(error) });
    } finally {
      setBusy(null);
    }
  }

  async function handleUnsubscribe() {
    if (!subscription) return;
    setBusy("subscribe");
    setResult(null);
    try {
      await subscription.unsubscribe();
      setSubscription(null);
      setResult({ kind: "success", text: "这台设备已取消订阅。" });
    } catch (error) {
      setResult({ kind: "error", text: explainError(error) });
    } finally {
      setBusy(null);
    }
  }

  async function handleSend() {
    const cleanMessage = message.trim();
    if (!subscription) {
      setResult({ kind: "error", text: "请先开启推送。" });
      return;
    }
    if (!cleanMessage) {
      setResult({ kind: "error", text: "请输入通知内容。" });
      return;
    }
    if (config?.requiresToken && !adminToken.trim()) {
      setResult({ kind: "error", text: "请输入 Railway 中配置的测试口令。" });
      return;
    }

    setBusy("send");
    setResult(null);
    try {
      const response = await fetch("/api/push/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subscription: subscription.toJSON(),
          message: cleanMessage,
          token: adminToken || undefined,
        }),
      });
      const payload = (await response.json()) as { success?: boolean; message?: string };

      if (!response.ok || !payload.success) {
        if (response.status === 410) {
          await subscription.unsubscribe().catch(() => undefined);
          setSubscription(null);
        }
        throw new Error(payload.message ?? "后端未能发送通知。请检查 Railway 日志。");
      }

      setResult({
        kind: "success",
        text: "推送服务已接收消息。现在可以切到主屏幕等待通知。",
      });
    } catch (error) {
      setResult({ kind: "error", text: explainError(error) });
    } finally {
      setBusy(null);
    }
  }

  const installHelpVisible = showInstallHelp || (isIOS && !isStandalone);
  const subscribeDisabled =
    phase !== "ready" || busy !== null || (isIOS && !isStandalone);

  return (
    <section className={styles.console} aria-labelledby="console-title">
      <header className={styles.header}>
        <div>
          <span className={styles.kicker}>DEVICE CONSOLE</span>
          <h2 id="console-title">推送测试台</h2>
        </div>
        <span className={`${styles.status} ${styles[status.tone]}`}>
          <span aria-hidden="true" />
          {status.label}
        </span>
      </header>

      <div className={styles.systemStatus} aria-label="环境状态">
        <span>
          <LockKeyhole size={13} aria-hidden="true" />
          {isSecure ? "安全连接" : "需要 HTTPS"}
        </span>
        <span>
          <Smartphone size={13} aria-hidden="true" />
          {isStandalone ? "已安装" : "浏览器模式"}
        </span>
        <span>
          <Bell size={13} aria-hidden="true" />
          通知{permissionLabel}
        </span>
      </div>

      <div className={styles.step}>
        <div className={styles.stepHeading}>
          <span>01</span>
          <div>
            <strong>安装到设备</strong>
            <p>iPhone 必须先添加到主屏幕，再从图标打开。</p>
          </div>
        </div>
        <button className={styles.secondaryButton} type="button" onClick={handleInstall} disabled={busy !== null}>
          {busy === "install" ? <LoaderCircle className={styles.spinner} size={17} /> : <Download size={17} />}
          {isStandalone ? "已安装" : installPrompt ? "安装应用" : "查看安装方法"}
        </button>
        {installHelpVisible && !isStandalone && (
          <div className={styles.installHelp}>
            <Share size={17} aria-hidden="true" />
            <p>
              在 Safari 点“分享”，选择“添加到主屏幕”，保持“作为 Web App 打开”开启，
              然后从新图标启动。
            </p>
          </div>
        )}
      </div>

      <div className={styles.step}>
        <div className={styles.stepHeading}>
          <span>02</span>
          <div>
            <strong>开启推送</strong>
            <p>权限只会在你点击按钮后请求。</p>
          </div>
        </div>
        {subscription ? (
          <button className={styles.subscribedButton} type="button" onClick={handleUnsubscribe} disabled={busy !== null}>
            {busy === "subscribe" ? <LoaderCircle className={styles.spinner} size={17} /> : <Check size={17} />}
            已订阅 · 点击取消
          </button>
        ) : (
          <button className={styles.secondaryButton} type="button" onClick={handleSubscribe} disabled={subscribeDisabled}>
            {busy === "subscribe" ? <LoaderCircle className={styles.spinner} size={17} /> : <Bell size={17} />}
            {phase === "booting" ? "正在准备" : "允许通知"}
          </button>
        )}
      </div>

      <div className={`${styles.step} ${styles.sendStep}`}>
        <div className={styles.stepHeading}>
          <span>03</span>
          <div>
            <strong>由后端发送</strong>
            <p>消息会经过 Railway 后端与推送服务。</p>
          </div>
        </div>
        <label className={styles.field}>
          <span>通知内容</span>
          <textarea
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            maxLength={160}
            rows={3}
            disabled={busy !== null}
          />
          <small>{message.length}/160</small>
        </label>
        {config?.requiresToken && (
          <label className={styles.field}>
            <span>测试口令</span>
            <input
              type="password"
              value={adminToken}
              onChange={(event) => setAdminToken(event.target.value)}
              autoComplete="off"
              placeholder="PUSH_ADMIN_TOKEN"
              disabled={busy !== null}
            />
          </label>
        )}
        <button className={styles.sendButton} type="button" onClick={handleSend} disabled={!subscription || busy !== null}>
          {busy === "send" ? <LoaderCircle className={styles.spinner} size={18} /> : <Send size={18} />}
          {busy === "send" ? "正在发送" : "发送测试通知"}
        </button>
      </div>

      {phase === "unconfigured" && (
        <div className={`${styles.notice} ${styles.noticeWarning}`} role="status">
          <Unplug size={17} aria-hidden="true" />
          <p>{config?.message ?? "服务端尚未配置 VAPID 密钥。"}</p>
        </div>
      )}
      {phase === "needs-install" && (
        <div className={`${styles.notice} ${styles.noticeWarning}`} role="status">
          <Smartphone size={17} aria-hidden="true" />
          <p>iPhone 上请先安装到主屏幕，再从应用图标打开本页。</p>
        </div>
      )}
      {phase === "unsupported" && (
        <div className={`${styles.notice} ${styles.noticeError}`} role="status">
          <Unplug size={17} aria-hidden="true" />
          <p>当前环境缺少 HTTPS、Service Worker 或 Push API 支持。</p>
        </div>
      )}
      {result && (
        <div
          className={`${styles.notice} ${result.kind === "success" ? styles.noticeSuccess : styles.noticeError}`}
          role="status"
          aria-live="polite"
        >
          {result.kind === "success" ? <Check size={17} aria-hidden="true" /> : <Unplug size={17} aria-hidden="true" />}
          <p>{result.text}</p>
        </div>
      )}
    </section>
  );
}
