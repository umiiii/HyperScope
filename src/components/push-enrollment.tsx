"use client";

import {
  Bell,
  BellOff,
  ChevronRight,
  LoaderCircle,
  Send,
  Share,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import styles from "./push-enrollment.module.css";

type PushConfig = {
  configured: boolean;
  publicKey: string | null;
  message?: string;
};

type PushState =
  | "loading"
  | "on"
  | "off"
  | "needs-install"
  | "unsupported"
  | "unconfigured"
  | "error";

function decodeApplicationKey(value: string) {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = `${value}${padding}`.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(window.atob(base64), (character) => character.charCodeAt(0));
}

function isIOS() {
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

function isStandalone() {
  const iosNavigator = navigator as Navigator & { standalone?: boolean };
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    iosNavigator.standalone === true
  );
}

async function syncSubscription(subscription: PushSubscription) {
  const response = await fetch("/api/push/subscriptions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subscription: subscription.toJSON() }),
  });
  if (!response.ok) throw new Error("设备订阅未能保存到服务器。");
}

export function PushEnrollment() {
  const registrationRef = useRef<ServiceWorkerRegistration | null>(null);
  const keyRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const subscriptionRef = useRef<PushSubscription | null>(null);
  const [state, setState] = useState<PushState>("loading");
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useState("正在检查这台设备");

  useEffect(() => {
    let active = true;

    async function prepare() {
      try {
        const iosNeedsInstall = isIOS() && !isStandalone();
        const configResponse = await fetch("/api/push/config", { cache: "no-store" });
        const config = (await configResponse.json()) as PushConfig;
        if (!active) return;

        if (!config.configured || !config.publicKey) {
          setState("unconfigured");
          setMessage(config.message || "服务端尚未配置推送");
          return;
        }

        if (
          !window.isSecureContext ||
          !("serviceWorker" in navigator) ||
          !("PushManager" in window) ||
          !("Notification" in window)
        ) {
          setState(iosNeedsInstall ? "needs-install" : "unsupported");
          setMessage(iosNeedsInstall ? "先添加到主屏幕，再开启通知" : "当前浏览器不支持 Web Push");
          return;
        }

        keyRef.current = decodeApplicationKey(config.publicKey);
        const registration = await navigator.serviceWorker.register("/sw.js", {
          scope: "/",
          updateViaCache: "none",
        });
        registrationRef.current = await navigator.serviceWorker.ready;
        const subscription = await registration.pushManager.getSubscription();
        if (!active) return;

        subscriptionRef.current = subscription;
        if (subscription) {
          await syncSubscription(subscription);
          setState("on");
          setMessage("仓位变化会推送到这台设备");
        } else if (iosNeedsInstall) {
          setState("needs-install");
          setMessage("先添加到主屏幕，再开启通知");
        } else {
          setState("off");
          setMessage("开启后，离开网页也能收到变化");
        }
      } catch (error) {
        if (!active) return;
        setState("error");
        setMessage(error instanceof Error ? error.message : "推送初始化失败");
      }
    }

    void prepare();
    return () => {
      active = false;
    };
  }, []);

  async function togglePush() {
    if (state === "needs-install") {
      setMessage("在 Safari 点分享 → 添加到主屏幕，然后从图标打开");
      return;
    }
    if (state === "unconfigured" || state === "unsupported" || state === "error") return;

    setBusy(true);
    try {
      if (state === "on" && subscriptionRef.current) {
        const endpoint = subscriptionRef.current.endpoint;
        await fetch("/api/push/subscriptions", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint }),
        });
        await subscriptionRef.current.unsubscribe();
        subscriptionRef.current = null;
        setState("off");
        setMessage("通知已关闭");
        return;
      }

      const registration = registrationRef.current;
      const applicationServerKey = keyRef.current;
      if (!registration || !applicationServerKey) throw new Error("推送服务尚未准备好。");

      const subscribePromise = registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey,
      });
      const subscription = await subscribePromise;
      await syncSubscription(subscription);
      subscriptionRef.current = subscription;
      setState("on");
      setMessage("仓位变化会推送到这台设备");
    } catch (error) {
      setState("error");
      setMessage(
        error instanceof DOMException && error.name === "NotAllowedError"
          ? "通知权限被拒绝，请到系统设置中重新允许"
          : error instanceof Error
            ? error.message
            : "无法开启通知",
      );
    } finally {
      setBusy(false);
    }
  }

  async function testPush() {
    const subscription = subscriptionRef.current;
    if (state !== "on" || !subscription) return;

    setTesting(true);
    try {
      await syncSubscription(subscription);
      const response = await fetch("/api/push/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscription: subscription.toJSON() }),
      });
      const payload = (await response.json().catch(() => null)) as
        | { message?: string }
        | null;
      if (!response.ok) {
        if (response.status === 410) {
          await subscription.unsubscribe().catch(() => false);
          subscriptionRef.current = null;
          setState("off");
        }
        throw new Error(payload?.message || "测试通知发送失败。");
      }
      setMessage(payload?.message || "测试通知已提交，请检查系统通知");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "测试通知发送失败");
    } finally {
      setTesting(false);
    }
  }

  const isOn = state === "on";
  const disabled =
    state === "loading" ||
    state === "unconfigured" ||
    state === "unsupported" ||
    state === "error";

  return (
    <div className={styles.wrapper}>
      <button
        className={styles.card}
        type="button"
        role="switch"
        aria-checked={isOn}
        onClick={togglePush}
        disabled={disabled || busy || testing}
      >
        <span className={isOn ? styles.iconOn : styles.icon} aria-hidden="true">
          {busy || state === "loading" ? (
            <LoaderCircle className={styles.spinner} size={19} />
          ) : state === "needs-install" ? (
            <Share size={18} />
          ) : isOn ? (
            <Bell size={18} />
          ) : (
            <BellOff size={18} />
          )}
        </span>
        <span className={styles.copy} aria-live="polite">
          <strong>{isOn ? "设备通知已开启" : state === "needs-install" ? "安装后开启通知" : "设备通知"}</strong>
          <small>{message}</small>
        </span>
        <span className={isOn ? styles.switchOn : styles.switch} aria-hidden="true">
          <span />
        </span>
        {state === "needs-install" && <ChevronRight className={styles.chevron} size={18} aria-hidden="true" />}
      </button>

      {isOn && (
        <button
          className={styles.testButton}
          type="button"
          onClick={testPush}
          disabled={busy || testing}
          aria-busy={testing}
        >
          {testing ? (
            <LoaderCircle className={styles.spinner} size={16} aria-hidden="true" />
          ) : (
            <Send size={16} aria-hidden="true" />
          )}
          {testing ? "正在发送测试通知" : "发送测试通知到这台设备"}
        </button>
      )}
    </div>
  );
}
