import {
  ArrowDownRight,
  BellRing,
  RadioTower,
  ShieldCheck,
} from "lucide-react";
import { PushConsole } from "@/components/push-console";
import styles from "./page.module.css";

export default function Home() {
  return (
    <main className={styles.page}>
      <nav className={styles.nav} aria-label="主导航">
        <a className={styles.brand} href="#top" aria-label="HyperScope 首页">
          <span className={styles.brandMark} aria-hidden="true">
            <span />
          </span>
          HyperScope
        </a>
        <span className={styles.navTag}>PUSH LAB · MVP 01</span>
      </nav>

      <section className={styles.hero} id="top">
        <div className={styles.heroCopy}>
          <div className={styles.eyebrow}>
            <RadioTower size={15} aria-hidden="true" />
            Web Push / iOS 16.4+
          </div>
          <h1>
            让网页在
            <br />
            <span>你离开后</span>
            <br />
            仍能抵达。
          </h1>
          <p className={styles.lead}>
            一个可以安装、订阅并由服务端发送通知的 Next.js PWA。
            三步完成真实设备推送测试。
          </p>
          <a className={styles.jumpLink} href="#push-console">
            开始测试
            <ArrowDownRight size={18} aria-hidden="true" />
          </a>
        </div>

        <div className={styles.consoleWrap} id="push-console">
          <PushConsole />
        </div>
      </section>

      <section className={styles.featureStrip} aria-label="MVP 能力">
        <article>
          <span className={styles.featureIcon} aria-hidden="true">
            <BellRing size={19} />
          </span>
          <div>
            <strong>真实 Web Push</strong>
            <p>不是页面内弹窗，关闭网页后仍可收到。</p>
          </div>
        </article>
        <article>
          <span className={styles.featureIcon} aria-hidden="true">
            <ShieldCheck size={19} />
          </span>
          <div>
            <strong>VAPID 服务端签名</strong>
            <p>私钥只保留在 Railway 运行环境中。</p>
          </div>
        </article>
        <div className={styles.buildStamp}>
          <span>STACK</span>
          <strong>NEXT.JS / SERVICE WORKER / RAILWAY</strong>
        </div>
      </section>
    </main>
  );
}
